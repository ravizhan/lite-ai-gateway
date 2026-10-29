import type { H3, H3Event } from 'h3'
import { getRouterParam } from 'h3'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { getDb } from '../db/index.ts'
import { createHubServer } from './hub.ts'
import { loadGroupSelection, loadServers } from './routes.ts'
import { handleMessagesPost } from './sse-messages.ts'
import { instrumentTransport, type McpLogContext } from './transport-log.ts'

/** 空闲等待上限（毫秒）：到点写一条 SSE 注释帧 */
const SSE_HEARTBEAT_MS = 15_000

/**
 * Workers 端 MCP-over-SSE 会话。
 * 会话注册表仅存活于单 isolate；isolate 回收/发版时长连接断开，客户端重连重建。
 */
interface WorkersSseSession {
  server: Server
  /** POST /messages 入队，由存活的 GET 上下文投递给协议层 */
  transport: WorkersSseTransport
  /** 日志与协议处理共用仍在发送响应流的 GET 生命周期 */
  ctx: McpLogContext
}

const sessions = new Map<string, WorkersSseSession>()

/**
 * 最小 Transport：start 空操作；send 把 server→client 消息入队并唤醒 SSE 响应体；
 * close 交给 SSE 响应体收尾（关闭流、注销会话、必要时关 server）。POST /messages 不经过
 * send——直接调 onmessage。队列/唤醒/收尾回调由 transport 自持，会话对象反向引用它——
 * 避免 transport ↔ session 循环构造（观察者必须在 connect 前挂到 transport 上）。
 */
class WorkersSseTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  readonly sessionId = crypto.randomUUID()
  /** 待发消息；由 SSE 响应体在 GET 请求上下文里消费 */
  readonly queue: JSONRPCMessage[] = []
  /** 入站消息也在 GET 上下文分发，避免异步 handler 随 POST 的 202 响应被取消 */
  readonly incoming: JSONRPCMessage[] = []
  /**
   * 唤醒正在等待的 SSE 响应体。由响应体在 GET 上下文里挂上/摘下，POST /messages 跨请求调用：
   * workerd 支持跨请求解析 Promise，并把续体调度回创建它的 GET 上下文执行。
   */
  wake: (() => void) | null = null
  /** 协议层 close 时的会话收尾钩子（handleSse 在建流前挂上） */
  onDispose: (() => void) | null = null
  closed = false

  async start(): Promise<void> {}

  receive(message: JSONRPCMessage): void {
    if (this.closed) return
    this.incoming.push(message)
    this.wake?.()
  }

  async send(message: JSONRPCMessage): Promise<void> {
    // 会话已收尾：丢弃迟到消息，也不去唤醒一个创建请求已完成的 Promise
    if (this.closed) return
    this.queue.push(message)
    this.wake?.()
  }

  async close(): Promise<void> {
    this.closed = true
    // 只做跨上下文安全的事：置位、唤醒 GET 里的响应体；流与 server 由 GET 上下文收尾
    this.wake?.()
    this.onDispose?.()
    this.onclose?.()
  }
}

/**
 * SSE 响应体：把 transport 队列泵成 text/event-stream，空闲时写注释帧保活。
 *
 * 空闲等待必须有定时器事件，否则 workerd 会把等待外部 Promise 的请求判为挂起。
 * 入站协议处理与出站写流都在这个 GET 上下文执行；POST 只入队并唤醒，避免 handler
 * 的异步续体随 POST 的 202 响应结束。心跳同时维持空闲连接与请求生命周期。
 */
class WorkersSseStream {
  private readonly encoder = new TextEncoder()
  private readonly transport: WorkersSseTransport
  /** 会话收尾（可能在任意上下文被调用，禁止在这里碰流） */
  private readonly onClosed: () => void
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null
  /** 停掉当前心跳定时器（未等待中为 null）；只在 GET 上下文调用 */
  private stopHeartbeat: (() => void) | null = null
  private closed = false

  readonly response: Response

  constructor(transport: WorkersSseTransport, endpoint: string, onClosed: () => void) {
    this.transport = transport
    this.onClosed = onClosed
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller
        // 2024-11-05 SSE 传输规范：首帧告知客户端向哪个端点 POST
        this.write(`event: endpoint\ndata: ${endpoint}\n\n`)
        // 同步跑到第一次等待（定时器已挂上）才返回，避免请求在事件循环空转时被判挂死
        void this.pump()
      },
      // 客户端断开：运行时在 GET 自己的请求上下文里调用，可安全解除等待并收尾
      cancel: () => this.close(),
    })
    this.response = new Response(body, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    })
  }

  /**
   * 幂等收尾：解除等待、关闭响应流，再交还会话清理。只在 GET 的请求上下文里调用——
   * 协议层从别的请求里关闭会话时只置 transport.closed 并唤醒，由 pump 回到这里收尾。
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.transport.closed = true
    this.transport.queue.length = 0
    this.transport.incoming.length = 0
    const wake = this.transport.wake
    this.transport.wake = null
    wake?.()
    this.clearHeartbeat()
    try {
      this.controller?.close()
    } catch {
      // 客户端断开时运行时已关闭该流
    }
    this.controller = null
    this.onClosed()
  }

  private async pump(): Promise<void> {
    try {
      while (!this.closed && !this.transport.closed) {
        const message = this.transport.queue.shift()
        if (message !== undefined) {
          if (!this.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`)) return
          continue
        }
        const incoming = this.transport.incoming.shift()
        if (incoming !== undefined) {
          this.transport.onmessage?.(incoming)
          continue
        }
        const reason = await this.waitForWork()
        if (this.closed || this.transport.closed) return
        if (reason === 'heartbeat' && !this.write(': keepalive\n\n')) return
        this.clearHeartbeat()
      }
    } catch {
      // 序列化/写流失败按连接断开处理，收尾统一走 finally
    } finally {
      this.close()
    }
  }

  /**
   * 等消息或心跳超时。'signal' 由 POST /messages 在另一个请求上下文里触发，所以唤醒路径不能
   * clearTimeout（跨请求操作定时器不是合法 I/O），清理统一回到 GET 上下文的 pump 里做。
   */
  private waitForWork(): Promise<'signal' | 'heartbeat'> {
    // tsconfig.server.json 的 lib 为 ES2022，没有 Promise.withResolvers
    return new Promise<'signal' | 'heartbeat'>((resolve) => {
      let settled = false
      const settle = (reason: 'signal' | 'heartbeat'): void => {
        if (settled) return
        settled = true
        this.transport.wake = null
        resolve(reason)
      }
      this.transport.wake = () => settle('signal')
      const timer = setTimeout(() => {
        this.stopHeartbeat = null
        settle('heartbeat')
      }, SSE_HEARTBEAT_MS)
      this.stopHeartbeat = () => {
        clearTimeout(timer)
        this.stopHeartbeat = null
      }
    })
  }

  private clearHeartbeat(): void {
    this.stopHeartbeat?.()
  }

  /** 写一帧；控制器已关闭/客户端已断开时返回 false */
  private write(chunk: string): boolean {
    if (this.controller === null) return false
    try {
      this.controller.enqueue(this.encoder.encode(chunk))
      return true
    } catch {
      return false
    }
  }
}

/**
 * 注册 Workers 端 MCP-over-SSE 端点（认证由父级挂 apiKeyMw 中间件）。
 * GET /sse[/:group]：建会话 → 返回 SSE 流（首帧 endpoint，随后队列消息）；
 * POST /messages?sessionId=：投递客户端消息 → 202。
 */
export function registerWorkersSse(app: H3): void {
  const handleSse = async (event: H3Event): Promise<Response> => {
    const db = getDb(event)
    // 线编码只还原一次；仅用于 SQL 参数、日志字段（Workers 无独立 endpoint 参数）
    const rawGroup = getRouterParam(event, 'group')
    const group = rawGroup === undefined ? null : decodeURIComponent(rawGroup)
    const servers = await loadServers(db, group)
    const selection = await loadGroupSelection(db, group)
    const ctx: McpLogContext = { db, groupName: group, waitUntil: (promise) => event.waitUntil(promise) }
    const transport = new WorkersSseTransport()
    // 观察者先于 connect 挂上（Protocol.connect 链式包装 onmessage/onclose）
    const logger = instrumentTransport(transport, ctx)
    const session: WorkersSseSession = {
      transport,
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
    // 挂上 transport.onmessage，POST /messages 才能投递；失败时尚未注册会话，无需清理
    await session.server.connect(transport)
    let ended = false
    /**
     * 会话收尾（幂等）：客户端断开、SSE 写失败、协议层 server.close() 都可能先到。
     * 只置位并唤醒 GET 上下文里的响应体；流与 server 的清理都在 GET 里完成（跨请求关流不是合法 I/O）。
     * fromServer=true 表示由 server.close() 触发，不再回调 server.close()（否则递归）。
     */
    const endSession = (fromServer: boolean): void => {
      if (ended) return
      ended = true
      transport.closed = true
      const wake = transport.wake
      transport.wake = null
      wake?.()
      sessions.delete(transport.sessionId)
      if (!fromServer) void session.server.close().catch(() => {})
    }
    transport.onDispose = () => endSession(true)
    // 注册与会话首帧同一时刻可见：sessionId 只随 endpoint 帧交给客户端，注册早于建流即可
    sessions.set(transport.sessionId, session)
    const stream = new WorkersSseStream(
      transport,
      `/messages?sessionId=${transport.sessionId}`,
      () => endSession(false),
    )
    return stream.response
  }

  app.get('/sse', handleSse)
  app.get('/sse/:group', handleSse)

  app.post('/messages', async (event): Promise<Response> => {
    const sessionId = event.url.searchParams.get('sessionId')
    const session = (sessionId ? sessions.get(sessionId) : undefined) ?? null
    return handleMessagesPost(event, getDb(event), session, async (target, message) => {
      // 在 GET 的存活上下文执行异步 handler；POST 只接收消息并返回 202。
      target.transport.receive(message)
      return new Response('Accepted', { status: 202 })
    })
  })
}
