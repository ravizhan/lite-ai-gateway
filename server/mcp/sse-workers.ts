import type { H3, H3Event } from 'h3'
import { getRouterParam } from 'h3'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { getDb } from '../db/index.ts'
import { createHubServer } from './hub.ts'
import { loadGroupSelection, loadServers } from './routes.ts'
import {
  instrumentTransport,
  isJsonRpcMessage,
  logMcpRejection,
  type McpLogContext,
  type TransportLogger,
} from './transport-log.ts'

/** SSE 帧 */
interface SseEvent {
  event: string
  data: string
}

/**
 * 内联的 sse()（替代 cloudflare-workers-sse：该包内部扩展名缺失的 ESM import 在纯 Node
 * strip-types 下无法解析，静态 import 会拖垮 Node 入口；本文件仅 Workers 挂载但模块图共享）。
 * 把 async generator 包成 text/event-stream Response；客户端断开时取消生成器（触发其 finally）。
 */
function sseResponse(source: () => AsyncGenerator<SseEvent>): Response {
  const encoder = new TextEncoder()
  let gen: AsyncGenerator<SseEvent> | null = null
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      gen = source()
      try {
        for await (const frame of gen) {
          controller.enqueue(encoder.encode(`event: ${frame.event}\ndata: ${frame.data}\n\n`))
        }
        controller.close()
      } catch {
        try { controller.close() } catch { /* 已关闭 */ }
      }
    },
    async cancel() {
      // 客户端断开：主动 return 生成器，触发其 finally 里的会话清理
      await gen?.return(undefined)
    },
  })
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  })
}

/**
 * Workers 端 MCP-over-SSE 会话（手写，见 plan.md 阶段 4）。
 * 会话注册表仅存活于单 isolate；isolate 回收/发版时长连接断开，客户端重连重建。
 */
interface WorkersSseSession {
  server: Server
  /** POST /messages 经 transport.onmessage 投递（server.connect 后挂上） */
  transport: WorkersSseTransport
  group: string | null
  /** 日志上下文；每次 POST 刷新 waitUntil（落库要挂在活的请求生命周期上） */
  ctx: McpLogContext
  logger: TransportLogger
}

const sessions = new Map<string, WorkersSseSession>()

/**
 * 最小 Transport：start 空操作；send 把 server→client 消息入队并唤醒 SSE 生成器；
 * close 标记会话关闭并从注册表移除。POST /messages 不经过 send——直接调 onmessage。
 * 队列/唤醒/关闭标记由 transport 自持，会话对象反向引用它——避免
 * transport ↔ session 循环构造（观察者必须在 connect 前挂到 transport 上）。
 */
class WorkersSseTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  readonly sessionId = crypto.randomUUID()
  queue: JSONRPCMessage[] = []
  notify: (() => void) | null = null
  closed = false

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    this.queue.push(message)
    this.notify?.()
  }

  async close(): Promise<void> {
    this.closed = true
    sessions.delete(this.sessionId)
    this.onclose?.()
  }
}

/**
 * /messages 的 JSON-RPC 错误体（会话不存在 -32001 / 报文非法 -32600 / 非法 JSON -32700）。
 * 返回字符串：日志 response_body 与实际响应体同源，保证“记的就是发的”。
 */
function jsonRpcErrorBody(code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } })
}

/** JSON 响应（错误体已就绪） */
function jsonResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

/**
 * 注册 Workers 端 MCP-over-SSE 端点（认证由父级挂 apiKeyMw 中间件）。
 * GET /sse[/:group]：建会话 → 返回 SSE 流（首帧 endpoint，随后队列消息）；
 * POST /messages?sessionId=：投递客户端消息 → 202。
 */
export function registerWorkersSse(app: H3): void {
  const handleSse = async (event: H3Event): Promise<Response> => {
    const db = getDb(event)
    const group = getRouterParam(event, 'group') ?? null
    const servers = await loadServers(db, group)
    const selection = await loadGroupSelection(db, group)
    const ctx: McpLogContext = { db, groupName: group, waitUntil: (promise) => event.waitUntil(promise) }
    const transport = new WorkersSseTransport()
    // 观察者先于 connect 挂上（Protocol.connect 链式包装 onmessage/onclose）
    const logger = instrumentTransport(transport, ctx)
    const session: WorkersSseSession = {
      transport,
      logger,
      group,
      ctx,
      server: createHubServer({
        db,
        servers,
        groupName: group,
        isNode: false,
        selection,
        onRoute: (info) => logger.setRoute(info),
      }),
    }
    sessions.set(transport.sessionId, session)
    try {
      await session.server.connect(transport) // 挂上 transport.onmessage，POST /messages 才能投递
    } catch (error) {
      sessions.delete(transport.sessionId)
      throw error
    }
    // 把 async generator 包成 text/event-stream Response（见 sseResponse 注释）
    return sseResponse(async function* () {
      try {
        // 2024-11-05 SSE 传输规范：首帧告知客户端向哪个端点 POST
        yield { event: 'endpoint', data: `/messages?sessionId=${transport.sessionId}` }
        while (!transport.closed) {
          if (transport.queue.length > 0) {
            const msg = transport.queue.shift()!
            yield { event: 'message', data: JSON.stringify(msg) }
            continue
          }
          await new Promise<void>((resolve) => {
            transport.notify = resolve
            // 挂起前已有消息入队（send 恰在检查与挂起之间执行）→ 立即唤醒
            if (transport.queue.length > 0) resolve()
          })
        }
      } finally {
        // 客户端断开 → 生成器被取消：清理会话并关闭 server
        transport.closed = true
        sessions.delete(transport.sessionId)
        void session.server.close()
      }
    })
  }

  app.get('/sse', handleSse)
  app.get('/sse/:group', handleSse)

  app.post('/messages', async (event): Promise<Response> => {
    const db = getDb(event)
    const sessionId = event.url.searchParams.get('sessionId')
    const session = sessionId ? sessions.get(sessionId) : undefined
    // 原始请求体先读一次：即使会话不存在/报文非法，日志里也要留下真实输入
    let rawBody: string | null = null
    let body: unknown
    let bodyParsed: boolean
    try {
      rawBody = await event.req.text()
      body = JSON.parse(rawBody)
      bodyParsed = true
    } catch {
      bodyParsed = false
    }
    if (!session) {
      const body = jsonRpcErrorBody(-32001, 'session not found')
      await logMcpRejection(
        // 会话未找到时组名只能取端点 query（/messages 无 :group 路由参数）
        { db, groupName: event.url.searchParams.get('group') },
        {
          method: 'POST /messages',
          error: 'HTTP 404: session not found',
          requestBody: rawBody,
          responseBody: body,
        },
      )
      return jsonResponse(body, 404)
    }
    // 会话是长连接：把落库生命周期挂到当前请求上（关闭补记/通知落库才有存活窗口）
    session.ctx.waitUntil = (promise) => event.waitUntil(promise)
    const mediaType = (event.req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (mediaType !== 'application/json') {
      const message = `Unsupported content-type: ${mediaType || '(missing)'}`
      await logMcpRejection(session.ctx, {
        method: 'POST /messages',
        error: `HTTP 400: ${message}`,
        requestBody: rawBody,
        responseBody: message,
      })
      return new Response(message, { status: 400 })
    }
    if (!bodyParsed || !isJsonRpcMessage(body)) {
      const message = bodyParsed ? `Invalid message: ${rawBody ?? ''}` : 'Parse error: Invalid JSON'
      const responseBody = jsonRpcErrorBody(bodyParsed ? -32600 : -32700, message)
      await logMcpRejection(session.ctx, {
        method: 'POST /messages',
        error: `HTTP 400: ${message}`,
        requestBody: rawBody,
        responseBody,
      })
      return jsonResponse(responseBody, 400)
    }
    // 投递给协议层：hub 处理完成后经 transport.send 写回 SSE 队列
    session.transport.onmessage?.(body as JSONRPCMessage)
    // 通知等无法 await 的落库在此等到可见（请求行在 transport.send 内已先落库再写队列）
    await session.logger.settled()
    return new Response('Accepted', { status: 202 })
  })
}
