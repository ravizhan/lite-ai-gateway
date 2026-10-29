import type { H3Event } from 'h3'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { Db } from '../db/types.ts'
import { isJsonRpcMessage, logMcpRejection, type McpLogContext } from './transport-log.ts'

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
 * POST /messages 的公共管线（Node 与 Workers 共用，无 node: 依赖）：
 * 原始请求体只读一次，依次校验会话存在、content-type、JSON 语法与 JSON-RPC 结构；
 * 任一不合法即落日志并返回拒绝响应（“记的就是发的”）。全部通过后交给运行时的 deliver 投递。
 *
 * session 为 null 表示会话未找到：此时组名只能取端点 query（/messages 无 :group 路由参数）。
 */
export async function handleMessagesPost<T extends { ctx: McpLogContext }, R>(
  event: H3Event,
  db: Db,
  session: T | null,
  deliver: (session: T, message: JSONRPCMessage) => Promise<R>,
): Promise<Response | R> {
  // 原始请求体先读一次：即使会话不存在/报文非法，日志里也要留下真实输入
  let rawBody: string | null = null
  let parsedBody: unknown
  let bodyParsed = false
  try {
    rawBody = await event.req.text()
    parsedBody = JSON.parse(rawBody)
    bodyParsed = true
  } catch {
    // 读取失败或非法 JSON：rawBody 保留已读原文，bodyParsed=false 走 400
  }
  if (session === null) {
    const body = jsonRpcErrorBody(-32001, 'session not found')
    await logMcpRejection(
      { db, groupName: event.url.searchParams.get('group'), waitUntil: (promise) => event.waitUntil(promise) },
      {
        method: 'POST /messages',
        error: 'HTTP 404: session not found',
        requestBody: rawBody,
        responseBody: body,
      },
    )
    return jsonResponse(body, 404)
  }
  const ctx = session.ctx
  const mediaType = (event.req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (mediaType !== 'application/json') {
    const message = `Unsupported content-type: ${mediaType || '(missing)'}`
    await logMcpRejection(ctx, {
      method: 'POST /messages',
      error: `HTTP 400: ${message}`,
      requestBody: rawBody,
      responseBody: message,
    })
    return new Response(message, { status: 400 })
  }
  if (!bodyParsed) {
    const body = jsonRpcErrorBody(-32700, 'Parse error: Invalid JSON')
    await logMcpRejection(ctx, {
      method: 'POST /messages',
      error: 'HTTP 400: Parse error: Invalid JSON',
      requestBody: rawBody,
      responseBody: body,
    })
    return jsonResponse(body, 400)
  }
  if (!isJsonRpcMessage(parsedBody)) {
    // 结构非法的 JSON-RPC 报文：传输层会写 400 但不记日志，这里自行判定并留痕
    const message = `Invalid message: ${rawBody ?? ''}`
    const body = jsonRpcErrorBody(-32600, message)
    await logMcpRejection(ctx, {
      method: 'POST /messages',
      error: `HTTP 400: ${message}`,
      requestBody: rawBody,
      responseBody: body,
    })
    return jsonResponse(body, 400)
  }
  return deliver(session, parsedBody)
}
