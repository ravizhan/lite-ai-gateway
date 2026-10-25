import type { H3, H3Event } from 'h3'
import { getRouterParam } from 'h3'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { McpServerRow } from '../../shared/api.ts'
import type { Db } from '../db/types.ts'
import { getDb } from '../db/index.ts'
import { createHubServer } from './hub.ts'
import { registerWorkersSse } from './sse-workers.ts'
import { getNodeMcpBindings } from './node-bindings.ts'
import { instrumentTransport, logMcpRejection, type McpLogContext } from './transport-log.ts'

/**
 * MCP 中转公开端点。认证（api key）由父级在 app.ts 通过
 * app.use('/mcp/**', apiKeyMw) 等统一挂载（见 server/auth.ts requireApiKey）；
 * 组 = :group 参数，无组 = 全部 enabled servers 的虚拟 default 组。
 */
export async function registerMcp(app: H3, runtime: 'node' | 'workers'): Promise<void> {
  // Streamable HTTP：无状态模式（不传 sessionIdGenerator），每请求新建
  // Server+transport；GET/DELETE 也透传给 transport 自行回 405/400。
  app.post('/mcp', handleStreamableHttp)
  app.post('/mcp/:group', handleStreamableHttp)
  app.get('/mcp', handleStreamableHttp)
  app.get('/mcp/:group', handleStreamableHttp)
  app.delete('/mcp', handleStreamableHttp)
  app.delete('/mcp/:group', handleStreamableHttp)

  if (runtime === 'node') {
    // sse-node 仅 Node（含 node:http 依赖）：实现由 Node 入口注入，避免进入 Workers bundle
    getNodeMcpBindings().registerNodeSse(app)
  } else {
    registerWorkersSse(app)
  }
}

/** 加载组内（或全部）enabled servers；组不存在 → 空列表（hub 返回空能力集） */
export async function loadServers(db: Db, groupName: string | null): Promise<McpServerRow[]> {
  if (groupName === null) {
    return db.all<McpServerRow>('SELECT * FROM mcp_servers WHERE enabled = 1')
  }
  // 组成员 = 有 ≥1 个已选能力的 enabled server；无任何选择 → 空集（不暴露任何能力）
  return db.all<McpServerRow>(
    `SELECT DISTINCT s.* FROM mcp_servers s
     JOIN mcp_group_capabilities gc ON gc.server_id = s.id
     JOIN mcp_groups g ON g.id = gc.group_id
     WHERE g.name = ? AND s.enabled = 1`,
    groupName,
  )
}

/** 加载组的能力白名单（`${serverId}:${kind}:${name}` 集合）；default 组 → null（不过滤） */
export async function loadGroupSelection(db: Db, groupName: string | null): Promise<Set<string> | null> {
  if (groupName === null) return null
  const rows = await db.all<{ server_id: number; kind: string; name: string }>(
    `SELECT gc.server_id, gc.kind, gc.name FROM mcp_group_capabilities gc
     JOIN mcp_groups g ON g.id = gc.group_id
     WHERE g.name = ?`,
    groupName,
  )
  return new Set(rows.map((r) => `${r.server_id}:${r.kind}:${r.name}`))
}

async function handleStreamableHttp(event: H3Event): Promise<Response> {
  const db = getDb(event)
  // 路由参数仍是线编码（h3 只对 %25 做防护）；组名含空格/CJK/字面 % 需还原一次。
  // 解码结果只进 SQL 参数、日志字段与再编码的 SSE endpoint，不参与路径路由/文件访问。
  const rawGroup = getRouterParam(event, 'group')
  const group = rawGroup === undefined ? null : decodeURIComponent(rawGroup)
  const isNode = event.runtime?.name === 'node'
  const servers = await loadServers(db, group)
  const selection = await loadGroupSelection(db, group)
  const ctx: McpLogContext = { db, groupName: group, waitUntil: (promise) => event.waitUntil(promise) }

  // POST 体读一次原文：request_body 要完整原文，且解析结果可作 parsedBody 交给 SDK
  // （避免 SDK 再读已消费的流）。解析失败的原文不能当 parsedBody 传——SDK 会把它当
  // “结构非法的消息”回 -32600；改为重建等价 Request 让 SDK 自行解析，保留 -32700
  // Parse error 语义。
  const isPost = event.req.method === 'POST'
  let rawBody: string | null = null
  let parsedBody: unknown
  let bodyParsed = false
  if (isPost) {
    try {
      rawBody = await event.req.text()
      parsedBody = JSON.parse(rawBody)
      bodyParsed = true
    } catch {
      bodyParsed = false
    }
  }
  const request = (isPost && rawBody !== null && !bodyParsed
    ? new Request(event.req.url, { method: 'POST', headers: event.req.headers, body: rawBody })
    : event.req) as unknown as Parameters<WebStandardStreamableHTTPServerTransport['handleRequest']>[0]

  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: false })
  // 观察者必须在 server.connect 之前挂上：Protocol.connect 会链式包装 onmessage/onclose
  const logger = instrumentTransport(transport, ctx)
  const server = createHubServer({
    db,
    servers,
    groupName: group,
    isNode,
    selection,
    onRoute: (info) => logger.setRoute(info),
  })
  await server.connect(transport)
  let response: Response
  try {
    response = await transport.handleRequest(request, bodyParsed ? { parsedBody } : undefined)
  } catch (error) {
    void server.close().catch(() => {})
    throw error
  }
  // 通知等无法 await 的落库在此等到可见；响应本身在 transport.send 内已先落库再写出
  await logger.settled()
  if (response.status >= 400) {
    // 协议层之前的拒绝（400 解析失败 / 406 / 415 / 405 / 404 会话等）：没有 JSON-RPC 消息
    // 可观察，直接落一条失败行（request_body = 原始请求体，response_body = HTTP 错误体）。
    // 读完原响应体再按原状态/头重建（错误体是普通 JSON，无流式内容）。
    const errorBody = await response.text().catch(() => null)
    await logMcpRejection(ctx, {
      method: `${event.req.method} ${event.url.pathname}`,
      error: `HTTP ${response.status}${errorBody ? `: ${errorBody}` : ''}`,
      requestBody: rawBody,
      responseBody: errorBody,
    })
    void server.close().catch(() => {})
    return errorBody === null ? response : new Response(errorBody, { status: response.status, headers: response.headers })
  }
  // 注意：不能在此处立即 server.close() —— hub 的工具调用是异步的，响应经
  // SSE 流写回；立即 close 会截断流中尚未写出的 JSON-RPC 响应。
  // 改为在响应流结束时（正常完成或客户端断开）再关闭 server/transport。
  const body = response.body
  if (!body) {
    void server.close()
    return response
  }
  // pipeTo 同时观察读端和写端的取消；即使上游不产出，也能解除挂起的读取。
  // 将收尾挂到生命周期，使运行时已通知的断开能完成协议关闭和上游取消。
  const passthrough = new TransformStream<Uint8Array, Uint8Array>()
  const close = (): Promise<void> => {
    event.req.signal.removeEventListener('abort', onAbort)
    return server.close()
  }
  const onAbort = (): void => { event.waitUntil(close()) }
  event.req.signal.addEventListener('abort', onAbort, { once: true })
  if (event.req.signal.aborted) onAbort()
  const completed = body.pipeTo(passthrough.writable).finally(close)
  // 流错误已传播到响应体；后台收尾只等待它结束，不再产生未处理的拒绝。
  event.waitUntil(completed.catch(() => {}))
  return new Response(passthrough.readable, { status: response.status, headers: response.headers })
}
