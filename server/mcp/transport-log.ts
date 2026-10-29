import type { MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js'
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type JSONRPCErrorResponse,
  type JSONRPCResultResponse,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js'
import type { Db } from '../db/types.ts'
import { logMcp } from './logs.ts'

/**
 * MCP 协议边界日志观察者。
 *
 * 在 `server.connect(transport)` **之前**包装 transport：`Protocol.connect` 会把已存在的
 * onmessage/onclose 链式包一层（先调我们的，再分发），因此每个入站 JSON-RPC 消息都会先经过
 * 这里；出站响应统一走 `transport.send`（含 SDK 的 MethodNotFound、handler 抛错、
 * tools/call 的 isError 结果）。一次客户端请求 = 恰好一条 `direction='call'` 行（`isUnloggedMethod` 的方法除外）：
 *   - request_body = 客户端原始 JSON-RPC 请求 JSON（原文，不截断）
 *   - response_body = 发给客户端的完整 JSON-RPC 响应 JSON（成功与失败均记录，原文，不截断）
 *   - 无响应（连接在响应前关闭）→ 关闭时补记一条失败行，response_body=null（不伪造响应）
 * 通知（无 id）即时落一条成功行。客户端发来的响应（无 pending）完全忽略。
 */

/** 不落日志的高频握手/发现方法：各类 `*\/list` 与 `notifications/initialized` */
function isUnloggedMethod(method: string): boolean {
  return method.endsWith('/list') || method === 'notifications/initialized'
}

/** 精确路由结果（hub 的 onRoute 回调提供；避免按前缀猜 server） */
export interface McpRouteInfo {
  id: RequestId
  /** 精确路由到的上游 server 名；路由/白名单失败时为 null */
  server_name: string | null
  /** 上游侧原始 tool/prompt 名（未加前缀）；不适用时省略 */
  tool_name?: string | null
}

export interface McpLogContext {
  db: Db
  groupName: string | null
  /**
   * 把落库挂到请求生命周期（Node/Workers 通用）。Node SSE 每次 POST 刷新它，
   * Workers SSE 使用持续存活的 GET 上下文；落库本体在 send 内已 await，不依赖此钩子。
   */
  waitUntil: (promise: Promise<void>) => void
}

/** 观察者句柄：hub 的 onRoute 回调写入精确元数据；settled 用于请求返回前等待已入队的落库 */
export interface TransportLogger {
  setRoute(info: McpRouteInfo): void
  /** 等待当前已入队的落库完成（通知等无法 await 的路径，保证响应返回时行已可见） */
  settled(): Promise<void>
}

interface PendingRequest {
  method: string
  requestBody: string
  startedAt: number
  serverName: string | null
  toolName: string | null
}

/** 入站请求/通知原文：JSON-RPC 报文是纯数据，JSON.stringify 不会失败 */
function stringifyMessage(message: JSONRPCMessage): string {
  return JSON.stringify(message)
}

/** tools/call isError 的错误摘要：取 content 里的文本，取不到用固定摘要 */
function summarizeToolError(result: unknown): string {
  if (!result || typeof result !== 'object' || !('content' in result)) return 'tool returned isError'
  const content = result.content
  if (!Array.isArray(content)) return 'tool returned isError'
  const texts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    if (!('type' in item) || item.type !== 'text') continue
    if (!('text' in item) || typeof item.text !== 'string' || item.text.length === 0) continue
    texts.push(item.text)
  }
  return texts.length > 0 ? texts.join('\n') : 'tool returned isError'
}

/**
 * 请求 id 归一键：JSON-RPC 的字符串 '1' 与数字 1 是两个不同请求，
 * 只按字符串归一会把两者的输入混成一条。
 * 错误响应的 id 可缺省（JSON-RPC 允许 id:null/无 id）——归一键仍可计算，
 * 但不会命中任何 pending（没有对应请求就不该有日志行）。
 */
function keyOf(id: RequestId | undefined): string {
  return `${typeof id}:${String(id)}`
}

/** tools/call、prompts/get 的 params.name 是客户端可见的完整名，先记为 tool_name（server 待 onRoute 精确回填） */
function toolNameFromRequest(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null
  if (!('name' in params)) return null
  return typeof params.name === 'string' ? params.name : null
}

/**
 * notifications/cancelled 的目标请求 id（无该字段/类型不对 → null）。
 * 被取消的请求 SDK 会 abort handler，成功与错误响应都不会再 send，
 * 因此必须在收到取消时就把 pending 结清，否则输入会滞留在内存里直到连接关闭。
 */
function cancelledRequestId(params: unknown): RequestId | null {
  if (!params || typeof params !== 'object' || !('requestId' in params)) return null
  const id = params.requestId
  return typeof id === 'string' || typeof id === 'number' ? id : null
}

export function instrumentTransport(transport: Transport, ctx: McpLogContext): TransportLogger {
  const pending = new Map<string, PendingRequest>()
  const inflight = new Set<Promise<void>>()

  function track(promise: Promise<void>): Promise<void> {
    const chained = promise
      .catch(() => {
        // logMcp 自身不抛；此处兜底，绝不把日志异常带进协议路径
      })
      .finally(() => inflight.delete(chained))
    inflight.add(chained)
    ctx.waitUntil(chained)
    return chained
  }

  async function persistPending(
    entry: PendingRequest,
    response: JSONRPCResultResponse | JSONRPCErrorResponse | null,
  ): Promise<void> {
    const durationMs = Date.now() - entry.startedAt
    const base = {
      direction: 'call' as const,
      group_name: ctx.groupName,
      server_name: entry.serverName,
      method: entry.method,
      tool_name: entry.toolName,
      duration_ms: durationMs,
    }
    if (response === null) {
      await logMcp(ctx.db, {
        ...base,
        ok: 0,
        error: 'connection closed before response',
        request_body: entry.requestBody,
        response_body: null,
      })
      return
    }
    if (isJSONRPCErrorResponse(response)) {
      await logMcp(ctx.db, {
        ...base,
        ok: 0,
        error: String(response.error.message ?? 'json-rpc error'),
        request_body: entry.requestBody,
        response_body: stringifyMessage(response),
      })
      return
    }
    const result = response.result
    const isToolError =
      result !== null &&
      typeof result === 'object' &&
      'isError' in result &&
      result.isError === true
    if (isToolError) {
      await logMcp(ctx.db, {
        ...base,
        ok: 0,
        error: summarizeToolError(result),
        request_body: entry.requestBody,
        response_body: stringifyMessage(response),
      })
      return
    }
    await logMcp(ctx.db, { ...base, ok: 1, request_body: entry.requestBody, response_body: stringifyMessage(response) })
  }

  const originalOnmessage = transport.onmessage
  transport.onmessage = (message: JSONRPCMessage, extra?: MessageExtraInfo) => {
    if (isJSONRPCRequest(message) && !isUnloggedMethod(message.method)) {
      const key = keyOf(message.id)
      const previous = pending.get(key)
      if (previous) {
        // 同一 id 重复：不静默覆盖，先前那条按“响应前被替换”记为失败，保留其原始输入
        pending.delete(key)
        void track(
          logMcp(ctx.db, {
            direction: 'call',
            group_name: ctx.groupName,
            server_name: previous.serverName,
            method: previous.method,
            tool_name: previous.toolName,
            duration_ms: Date.now() - previous.startedAt,
            ok: 0,
            error: `duplicate request id ${key} replaced before response`,
            request_body: previous.requestBody,
            response_body: null,
          }),
        )
      }
      pending.set(key, {
        method: message.method,
        requestBody: stringifyMessage(message),
        startedAt: Date.now(),
        serverName: null,
        toolName:
          message.method === 'tools/call' || message.method === 'prompts/get'
            ? toolNameFromRequest(message.params)
            : null,
      })
    } else if (isJSONRPCNotification(message) && !isUnloggedMethod(message.method)) {
      void track(
        logMcp(ctx.db, {
          direction: 'call',
          group_name: ctx.groupName,
          server_name: null,
          method: message.method,
          tool_name: null,
          duration_ms: 0,
          ok: 1,
          request_body: stringifyMessage(message),
          response_body: null,
        }),
      )
      // 取消通知：被取消的请求不会再收到任何响应（SDK abort handler 后既不 send 结果也不 send 错误），
      // 必须在收到取消时就结清 pending，否则这条输入要等到连接关闭才落库（且会被误标为连接关闭）。
      // 不伪造响应体：确实不存在响应。
      const cancelledId = message.method === 'notifications/cancelled' ? cancelledRequestId(message.params) : null
      if (cancelledId !== null) {
        const key = keyOf(cancelledId)
        const cancelled = pending.get(key)
        if (cancelled) {
          pending.delete(key)
          void track(
            logMcp(ctx.db, {
              direction: 'call',
              group_name: ctx.groupName,
              server_name: cancelled.serverName,
              method: cancelled.method,
              tool_name: cancelled.toolName,
              duration_ms: Date.now() - cancelled.startedAt,
              ok: 0,
              error: `request cancelled by client (${key})`,
              request_body: cancelled.requestBody,
              response_body: null,
            }),
          )
        }
      }
    }
    // 客户端发来的响应（sampling/roots 等）不属于请求日志，忽略
    originalOnmessage?.(message, extra)
  }

  const originalSend = transport.send.bind(transport)
  transport.send = async (message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> => {
    let entry: PendingRequest | undefined
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      const key = keyOf(message.id)
      entry = pending.get(key)
      if (entry) pending.delete(key)
      // 先落库再发送：客户端拿到响应时日志行必然已存在（顺序确定，无需等待/轮询）
      if (entry) await track(persistPending(entry, message))
    }
    await originalSend(message, options)
  }

  const originalOnclose = transport.onclose
  transport.onclose = () => {
    originalOnclose?.()
    if (pending.size === 0) return
    const orphans = [...pending.values()]
    pending.clear()
    void track(
      (async () => {
        for (const orphan of orphans) await persistPending(orphan, null)
      })(),
    )
  }

  return {
    setRoute(info) {
      const entry = pending.get(keyOf(info.id))
      if (!entry) return
      entry.serverName = info.server_name
      if (info.tool_name !== undefined) entry.toolName = info.tool_name
    },
    async settled() {
      while (inflight.size > 0) await Promise.all([...inflight])
    },
  }
}

/**
 * 协议层之前的 HTTP 拒绝（400 解析失败 / 406 / 415 / 404 会话 / 405 等）：
 * 没有 JSON-RPC 消息可观察，直接落一条失败行（request_body = 原始请求体，response_body = HTTP 错误体）。
 */
export async function logMcpRejection(
  ctx: McpLogContext,
  entry: {
    /** 形如 'POST /mcp'（含 HTTP 方法与路径） */
    method: string
    error: string
    requestBody: string | null
    responseBody: string | null
  },
): Promise<void> {
  await logMcp(ctx.db, {
    direction: 'call',
    group_name: ctx.groupName,
    server_name: null,
    method: entry.method,
    tool_name: null,
    duration_ms: 0,
    ok: 0,
    error: entry.error,
    request_body: entry.requestBody,
    response_body: entry.responseBody,
  })
}

/**
 * 结构合法的 JSON-RPC 单条报文（请求 / 通知 / 响应四选一，等价 SDK 的 JSONRPCMessageSchema，
 * 用于在委托传输层之前判定“结构非法的报文”，否则该 400 拒绝不可观测、无法留痕）。
 */
export function isJsonRpcMessage(value: unknown): value is JSONRPCMessage {
  return (
    isJSONRPCRequest(value) ||
    isJSONRPCNotification(value) ||
    isJSONRPCResultResponse(value) ||
    isJSONRPCErrorResponse(value)
  )
}
