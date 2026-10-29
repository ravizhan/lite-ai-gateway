import { onDispose, type H3Event } from 'h3'
import { gatewayError } from '../../shared/api.ts'
import type { Db } from '../db/types.ts'
import type { ConcurrencyPermit } from './concurrency.ts'
import {
  resolveExplicitRoute,
  resolveRoute,
  type RouteProtocol,
  type RoutedProvider,
} from './router.ts'

/**
 * relay.ts / embed.ts 共用：请求体读取与校验、候选路由解析、并发租约跟踪、
 * 503 构造、错误详情读取与截断。只放两条中继路径语义完全一致的逻辑。
 */

export function routingStateUnavailable(): Response {
  return gatewayError(503, 'routing state unavailable', 'api_error')
}

export function concurrencyStateUnavailable(): Response {
  return gatewayError(503, 'concurrency state unavailable', 'api_error')
}

export async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return
  try {
    await body.cancel()
  } catch {
    // The connection is already ending; permit release must still proceed.
  }
}

/** 错误详情捕获上限 256KB（超出截断，防止异常大响应撑爆单行） */
export const MAX_DETAIL_BODY = 256 * 1024

/** 拼接已累积的 chunk 并截断到 MAX_DETAIL_BODY */
export function concatDetailChunks(chunks: Uint8Array[], len: number): Uint8Array {
  const all = new Uint8Array(Math.min(len, MAX_DETAIL_BODY))
  let off = 0
  for (const c of chunks) {
    const slice = c.subarray(0, Math.min(c.byteLength, all.byteLength - off))
    all.set(slice, off)
    off += slice.byteLength
    if (off >= all.byteLength) break
  }
  return all
}

/** 错误详情文本：解码并截断到 MAX_DETAIL_BODY */
export function detailText(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return new TextDecoder().decode(view.subarray(0, MAX_DETAIL_BODY))
}

/** 读取整个响应体为文本（截断到 MAX_DETAIL_BODY）；仅错误路径调用 */
export async function readBodyText(
  body: ReadableStream<Uint8Array> | null,
): Promise<string | null> {
  if (!body) return null
  try {
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let len = 0
    while (len < MAX_DETAIL_BODY) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      len += value.byteLength
    }
    void reader.cancel().catch(() => {})
    return detailText(concatDetailChunks(chunks, len))
  } catch {
    return null
  }
}

/** 租约跟踪：请求结束（含客户端断开）时释放，finished 用于 waitUntil 收尾 */
export function trackPermit(event: H3Event, permit: ConcurrencyPermit): void {
  onDispose(event, () => permit.release())
  event.waitUntil(permit.finished)
}

export interface RelayRequestBody {
  /** 原始 bytes：逐 provider 原样重放 */
  rawBody: ArrayBuffer
  /** 解析对象：仅用于 routing/session 状态 */
  body: Record<string, unknown>
  model: string
  /** 客户端原始请求体文本（仅错误请求落库 req_body） */
  text: string
}

/** 读取并校验请求体；失败返回 400 响应。 */
export async function readRelayRequestBody(event: H3Event): Promise<RelayRequestBody | Response> {
  let rawBody: ArrayBuffer
  try {
    rawBody = await event.req.arrayBuffer()
  } catch {
    return gatewayError(400, 'failed to read request body')
  }

  try {
    const text = new TextDecoder().decode(rawBody)
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return gatewayError(400, 'invalid JSON body')
    }
    const body = parsed as Record<string, unknown>
    if (typeof body.model !== 'string' || body.model.length === 0) {
      return gatewayError(400, 'missing model parameter')
    }
    return { rawBody, body, model: body.model, text }
  } catch {
    return gatewayError(400, 'invalid JSON body')
  }
}

export interface ResolvedRoute {
  /** 对外模型 id（路由/计费/并发/日志统一使用） */
  model: string
  candidates: RoutedProvider[]
  /** 请求带 provider 前缀 → 跳过粘性绑定 */
  explicitSelection: boolean
}

/** 解析候选 provider；路由状态不可用 → 503，无候选 → 404。 */
export async function resolveRelayRoute(
  db: Db,
  requestedModel: string,
  protocol: RouteProtocol,
): Promise<ResolvedRoute | Response> {
  try {
    const explicit = await resolveExplicitRoute(db, requestedModel, protocol)
    if (explicit.matched) {
      if (!explicit.provider) return gatewayError(explicit.status, explicit.message)
      return { model: explicit.model, candidates: [explicit.provider], explicitSelection: true }
    }

    const routed = await resolveRoute(db, requestedModel)
    const candidates =
      protocol === 'responses'
        ? routed.filter((provider) => provider.type === 'llm' && provider.supports_responses === 1)
        : routed
    if (candidates.length === 0) {
      return gatewayError(404, `no provider for model ${requestedModel}`)
    }
    return { model: requestedModel, candidates, explicitSelection: false }
  } catch {
    return routingStateUnavailable()
  }
}
