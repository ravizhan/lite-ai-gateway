import type { IncomingMessage, ServerResponse } from 'node:http'
import type { H3, H3Event } from 'h3'
import { getRouterParam } from 'h3'
import { HTTPError } from 'h3'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { getDb } from '../db/index.ts'
import { createHubServer } from './hub.ts'
import { loadGroupSelection, loadServers } from './routes.ts'
import { handleMessagesPost } from './sse-messages.ts'
import { instrumentTransport, type McpLogContext, type TransportLogger } from './transport-log.ts'

interface NodeSseEntry {
  transport: SSEServerTransport
  /** 长连接会话的日志上下文；每次请求刷新 waitUntil（关闭补记要挂在活的请求生命周期上） */
  ctx: McpLogContext
  logger: TransportLogger
}

// sessionId → { transport, ctx, logger }；POST /messages 按 sessionId 路由
const transports = new Map<string, NodeSseEntry>()

/**
 * Node-only MCP-over-SSE（旧式 SSE 传输，兼容老客户端；SDK 已标记 deprecated 但保留）。
 * 本文件只被 Node 入口静态引入（server/node.ts → mcp/bindings-node.ts），node:http 依赖不会进入 Workers bundle。
 */
export function registerNodeSse(app: H3): void {
  const handleSse = async (event: H3Event): Promise<Response> => {
    const db = getDb(event)
    // 线编码只还原一次；仅用于 SQL 参数、日志字段与 encodeURIComponent 后的 endpoint
    const rawGroup = getRouterParam(event, 'group')
    const group = rawGroup === undefined ? null : decodeURIComponent(rawGroup)
    const node = event.runtime?.node
    if (!node?.res) {
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
    transports.set(transport.sessionId, { transport, ctx, logger })
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
    const sessionId = event.url.searchParams.get('sessionId')
    const entry = (sessionId ? transports.get(sessionId) : undefined) ?? null
    // 会话是长连接：把落库生命周期挂到当前请求上（关闭补记/通知落库才有存活窗口）
    if (entry) entry.ctx.waitUntil = (promise) => event.waitUntil(promise)
    return handleMessagesPost(event, getDb(event), entry, async (session, message) => {
      const node = event.runtime?.node
      if (!node?.req || !node?.res) {
        throw new HTTPError({ status: 500, message: 'messages endpoint requires node runtime' })
      }
      // handlePostMessage 自行写 node res（202 Accepted 或错误响应）
      await session.transport.handlePostMessage(
        node.req as unknown as IncomingMessage,
        node.res as unknown as ServerResponse,
        message,
      )
      // 通知等无法 await 的落库在此等到可见（请求行在 transport.send 内已先落库再写出）
      await session.logger.settled()
      // 返回 undefined：h3 对已结束的 res 再 end() 是 no-op（srvx writeHead 也会跳过）
      return undefined
    })
  })
}
