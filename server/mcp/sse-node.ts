import type { IncomingMessage, ServerResponse } from 'node:http'
import type { H3, H3Event } from 'h3'
import { getRouterParam } from 'h3'
import { HTTPError } from 'h3'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
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

interface NodeSseEntry {
  transport: SSEServerTransport
  server: Server
  group: string | null
  /** 长连接会话的日志上下文；每次请求刷新 waitUntil（关闭补记要挂在活的请求生命周期上） */
  ctx: McpLogContext
  logger: TransportLogger
}

// sessionId → { transport, server, group }；POST /messages 按 sessionId 路由
const transports = new Map<string, NodeSseEntry>()

/**
 * Node-only MCP-over-SSE（旧式 SSE 传输，兼容老客户端；SDK 已标记 deprecated 但保留）。
 * 本文件只被 Node 入口静态引入（server/node.ts → mcp/bindings-node.ts），node:http 依赖不会进入 Workers bundle。
 */
export function registerNodeSse(app: H3): void {
  const handleSse = async (event: H3Event): Promise<Response> => {
    const db = getDb(event)
    const group = getRouterParam(event, 'group') ?? null
    const node = event.runtime?.node
    if (event.runtime?.name !== 'node' || !node?.res) {
      throw new HTTPError({ status: 500, message: 'sse endpoint requires node runtime' })
    }
    const servers = await loadServers(db, group)
    const selection = await loadGroupSelection(db, group)
    // endpoint 为相对路径；sessionId 由 transport.start() 追加为 query 参数
    const endpoint = `/messages${group ? `?group=${encodeURIComponent(group)}` : ''}`
    const transport = new SSEServerTransport(endpoint, node.res as unknown as ServerResponse)
    const ctx: McpLogContext = { db, groupName: group, waitUntil: (promise) => event.waitUntil(promise) }
    // 注意：Protocol.connect 会链式包装 onclose；而 server.close() → transport.close()
    // 会再次触发 onclose —— 必须加防重入标记，否则无限递归。
    // 这个 onclose 必须先装、再装观察者（观察者链式包住它），否则会被覆盖掉，
    // 会话断开时的“未完成请求补记”就永远不会触发。
    let closed = false
    transport.onclose = () => {
      if (closed) return
      closed = true
      transports.delete(transport.sessionId)
      void server.close()
    }
    // 观察者先于 connect 挂上（Protocol.connect 链式包装 onmessage/onclose）
    const logger = instrumentTransport(transport, ctx)
    const server = createHubServer({
      db,
      servers,
      groupName: group,
      isNode: true,
      selection,
      onRoute: (info) => logger.setRoute(info),
    })
    transports.set(transport.sessionId, { transport, server, group, ctx, logger })
    await server.connect(transport) // connect → transport.start()：写 SSE 头 + endpoint 帧
    // SSEServerTransport 已把响应直接写入 node res；这里返回一个“永不结束”的
    // 占位流，防止 h3/srvx 在 handler 返回后立即 end() 响应截断 SSE 连接
    // （srvx 的 writeHead 会跳过已发送头的 res，流的取消发生在客户端断开时）。
    return new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          void transport.close()
        },
      }),
    )
  }

  app.get('/sse', handleSse)
  app.get('/sse/:group', handleSse)

  app.post('/messages', async (event): Promise<Response | undefined> => {
    const db = getDb(event)
    const sessionId = event.url.searchParams.get('sessionId')
    const entry = sessionId ? transports.get(sessionId) : undefined
    // 原始请求体先读一次：即使会话不存在/报文非法，日志里也要留下真实输入
    let rawBody: string | null = null
    let parsedBody: unknown
    let bodyParsed: boolean
    try {
      rawBody = await event.req.text()
      parsedBody = JSON.parse(rawBody)
      bodyParsed = true
    } catch {
      bodyParsed = false
    }
    if (!entry) {
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
    const node = event.runtime?.node
    if (event.runtime?.name !== 'node' || !node?.req || !node?.res) {
      throw new HTTPError({ status: 500, message: 'messages endpoint requires node runtime' })
    }
    // 会话是长连接：把落库生命周期挂到当前请求上（关闭补记/通知落库才有存活窗口）
    entry.ctx.waitUntil = (promise) => event.waitUntil(promise)
    const mediaType = (event.req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (mediaType !== 'application/json') {
      const message = `Unsupported content-type: ${mediaType || '(missing)'}`
      await logMcpRejection(entry.ctx, {
        method: 'POST /messages',
        error: `HTTP 400: ${message}`,
        requestBody: rawBody,
        responseBody: message,
      })
      return new Response(message, { status: 400 })
    }
    if (!bodyParsed) {
      const body = jsonRpcErrorBody(-32700, 'Parse error: Invalid JSON')
      await logMcpRejection(entry.ctx, {
        method: 'POST /messages',
        error: 'HTTP 400: Parse error: Invalid JSON',
        requestBody: rawBody,
        responseBody: body,
      })
      return jsonResponse(body, 400)
    }
    if (!isJsonRpcMessage(parsedBody)) {
      // 结构非法的 JSON-RPC 报文：SDK 会写 400 但不记日志，这里自行判定并留痕
      const message = `Invalid message: ${rawBody ?? ''}`
      await logMcpRejection(entry.ctx, {
        method: 'POST /messages',
        error: `HTTP 400: ${message}`,
        requestBody: rawBody,
        responseBody: message,
      })
      return new Response(message, { status: 400 })
    }
    // handlePostMessage 自行写 node res（202 Accepted 或错误响应）
    await entry.transport.handlePostMessage(
      node.req as unknown as IncomingMessage,
      node.res as unknown as ServerResponse,
      parsedBody,
    )
    // 通知等无法 await 的落库在此等到可见（请求行在 transport.send 内已先落库再写出）
    await entry.logger.settled()
    // 返回 undefined：h3 对已结束的 res 再 end() 是 no-op（srvx writeHead 也会跳过）
    return undefined
  })
}
