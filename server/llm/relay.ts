import { getRequestIP, onDispose, type H3Event } from 'h3'
import { getDb } from '../db/index.ts'
import { gatewayError, type PriceRow } from '../../shared/api.ts'
import { sanitizeError } from '../lib/sanitize.ts'
import { upstreamTimeout } from '../lib/timeout.ts'
import { tryAcquireConcurrency, type ConcurrencyPermit } from './concurrency.ts'
import {
  claimAffinityProvider,
  extractAffinityKey,
  getAffinityBinding,
  invalidateAffinityProvider,
  type AffinityBinding,
  type AffinityKey,
} from './session-affinity.ts'
import {
  resolveExplicitRoute,
  resolveRoute,
  type RoutedProvider,
} from './router.ts'
import { loadGatewaySettings } from '../settings.ts'
import {
  calcTps,
  computeCost,
  normalizeChatUsage,
  normalizeResponsesUsage,
  type NormalizedUsage,
} from './usage.ts'
import { createSseTap } from './sse-tap.ts'

interface RelayOpts {
  protocol: 'chat' | 'responses'
  path: '/chat/completions' | '/responses'
}

/** llm_logs 落库行（usage/ttft/tps/cost/error 缺省由 insertLog 兜底为 0/null） */
interface LogEntry {
  apiKeyId: number | null
  protocol: 'chat' | 'responses'
  model: string
  providerId: number | null
  providerName: string | null
  stream: 0 | 1
  status: number
  durationMs: number
  usage?: NormalizedUsage
  ttftMs?: number | null
  tps?: number | null
  cost?: number
  error?: string | null
  clientIp: string | null
  /** 仅错误请求（最终状态非 200）记录；正常请求省略 → NULL */
  reqBody?: string | null
  respBody?: string | null
}

/** 写一条 llm_logs（单条 INSERT，D1 子请求预算内） */
async function insertLog(event: H3Event, row: LogEntry): Promise<void> {
  const usage = row.usage ?? { prompt: 0, completion: 0, cached: 0, total: 0 }
  await getDb(event).run(
    `INSERT INTO llm_logs (
       api_key_id, protocol, model, provider_id, provider_name, stream, status,
       prompt_tokens, completion_tokens, cached_tokens, total_tokens,
       ttft_ms, duration_ms, tps, cost, error, client_ip, req_body, resp_body
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.apiKeyId,
    row.protocol,
    row.model,
    row.providerId,
    row.providerName,
    row.stream,
    row.status,
    usage.prompt,
    usage.completion,
    usage.cached,
    usage.total,
    row.ttftMs ?? null,
    row.durationMs,
    row.tps ?? null,
    row.cost ?? 0,
    row.error ?? null,
    row.clientIp,
    row.reqBody ?? null,
    row.respBody ?? null,
  )
}

function routingStateUnavailable(): Response {
  return gatewayError(503, 'routing state unavailable', 'api_error')
}

function concurrencyStateUnavailable(): Response {
  return gatewayError(503, 'concurrency state unavailable', 'api_error')
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return
  try {
    await body.cancel()
  } catch {
    // The connection is already ending; permit release must still proceed.
  }
}

/** 错误详情捕获上限 256KB（超出截断，防止异常大响应撑爆单行） */
const MAX_DETAIL_BODY = 256 * 1024

/** 读取整个响应体为文本（截断到 MAX_DETAIL_BODY）；仅错误路径调用 */
async function readBodyText(body: ReadableStream<Uint8Array> | null): Promise<string | null> {
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
    const all = new Uint8Array(Math.min(len, MAX_DETAIL_BODY))
    let off = 0
    for (const c of chunks) {
      const slice = c.subarray(0, Math.min(c.byteLength, all.byteLength - off))
      all.set(slice, off)
      off += slice.byteLength
      if (off >= all.byteLength) break
    }
    return new TextDecoder().decode(all)
  } catch {
    return null
  }
}

/**
 * 透传同时捕获全文（截断到 MAX_DETAIL_BODY）；流结束后 resolve 捕获文本。
 * 用于 4xx 透传分支：字节原样转发给客户端，结束后把完整响应体写进日志。
 */
function captureTap(source: ReadableStream<Uint8Array>): {
  stream: ReadableStream<Uint8Array>
  text: Promise<string | null>
} {
  const chunks: Uint8Array[] = []
  let len = 0
  let resolveText: (value: string | null) => void = () => {}
  const text = new Promise<string | null>((resolve) => {
    resolveText = resolve
  })
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (len < MAX_DETAIL_BODY) {
        chunks.push(chunk)
        len += chunk.byteLength
      }
      controller.enqueue(chunk)
    },
    flush() {
      const all = new Uint8Array(Math.min(len, MAX_DETAIL_BODY))
      let off = 0
      for (const c of chunks) {
        const slice = c.subarray(0, Math.min(c.byteLength, all.byteLength - off))
        all.set(slice, off)
        off += slice.byteLength
        if (off >= all.byteLength) break
      }
      resolveText(new TextDecoder().decode(all))
    },
  })
  // 取消/断流：pipeTo 可能 reject，也可能在 flush 未执行时 resolve（老版本 Workers 的取消路径）；
  // 两个分支都兜底 resolveText(null)，正常 flush 已先行 resolve，Promise 首次 resolve 生效。
  const interrupted = (): void => resolveText(null)
  void source.pipeTo(stream.writable).then(interrupted, interrupted)
  return { stream: stream.readable, text }
}

export async function relayChat(event: H3Event): Promise<Response> {
  return relay(event, { protocol: 'chat', path: '/chat/completions' })
}

export async function relayResponses(event: H3Event): Promise<Response> {
  return relay(event, { protocol: 'responses', path: '/responses' })
}

/**
 * LLM 中转核心。失败切换规则（锁定）：
 * - 仅「网络错误/超时 或 5xx」且「尚未转发任何字节」时切换下一 provider；
 * - 4xx（含 401/403/404/429）直接透传不重试；
 * - 流式一旦开始转发即不再切换（中途断流由 sse-tap 记 error 日志）。
 */
async function relay(event: H3Event, opts: RelayOpts): Promise<Response> {
  // 认证由父级 app.ts 挂载的 app.use('/v1/**', apiKeyMw) 完成（见 server/auth.ts requireApiKey）。
  const apiKeyId = event.context.apiKeyId as number | undefined
  if (apiKeyId === undefined) return routingStateUnavailable()

  const clientIp = getRequestIP(event) ?? null
  const t0 = performance.now()

  // 原始 bytes 用于逐 provider 原样重放；解析对象仅用于 routing/session 状态。
  let rawBody: ArrayBuffer
  try {
    rawBody = await event.req.arrayBuffer()
  } catch {
    return gatewayError(400, 'failed to read request body')
  }

  let body: Record<string, unknown>
  let requestedModel: string
  let stream: boolean
  let clientReqBody: string
  try {
    clientReqBody = new TextDecoder().decode(rawBody)
    const parsed = JSON.parse(clientReqBody) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return gatewayError(400, 'invalid JSON body')
    }
    body = parsed as Record<string, unknown>
    if (typeof body.model !== 'string' || body.model.length === 0) {
      return gatewayError(400, 'missing model parameter')
    }
    requestedModel = body.model
    stream = body.stream === true
  } catch {
    return gatewayError(400, 'invalid JSON body')
  }

  const db = getDb(event)
  // model = 对外模型 id（路由/计费/并发/日志统一使用）；upstream_model 由各 provider 行的 alias 映射决定
  let model = requestedModel
  let candidates: RoutedProvider[]
  let explicitSelection = false
  const requestPath = new URL(event.req.url, 'http://gateway.local').pathname
  try {
    const explicit = await resolveExplicitRoute(db, requestedModel, opts.protocol)
    if (explicit.matched) {
      if (!explicit.provider) return gatewayError(explicit.status, explicit.message)
      explicitSelection = true
      model = explicit.model
      candidates = [explicit.provider]
    } else {
      const routed = await resolveRoute(db, requestedModel)
      candidates =
        opts.protocol === 'responses'
          ? routed.filter((provider) => provider.type === 'llm' && provider.supports_responses === 1)
          : routed
    }
  } catch {
    return routingStateUnavailable()
  }
  if (candidates.length === 0) {
    return gatewayError(404, `no provider for model ${requestedModel}`)
  }

  let affinityKey: AffinityKey | null = null
  let affinityBinding: AffinityBinding | null = null
  if (!explicitSelection) {
    try {
      const settings = await loadGatewaySettings(db)
      affinityKey = await extractAffinityKey(
        apiKeyId,
        opts.protocol,
        model,
        event.req.headers,
        body,
        settings.affinity,
        requestPath,
      )
      if (affinityKey) affinityBinding = await getAffinityBinding(db, affinityKey, Date.now())
    } catch {
      return routingStateUnavailable()
    }
  }

  const base = {
    apiKeyId,
    protocol: opts.protocol,
    model,
    stream: (stream ? 1 : 0) as 0 | 1,
    clientIp,
  }
  const providerById = new Map(candidates.map((provider) => [provider.id, provider]))
  const triedProviderIds = new Set<number>()
  let attemptedUpstream = false
  let mayMutateAffinity = affinityKey !== null
  let coordinationSteps = 0
  const maxCoordinationSteps = candidates.length + 1

  const trackPermit = (permit: ConcurrencyPermit): void => {
    if (!permit.finished) return
    onDispose(event, () => permit.release())
    event.waitUntil(permit.finished)
  }

  const acquire = async (provider: RoutedProvider): Promise<ConcurrencyPermit | null> => {
    const permit = await tryAcquireConcurrency(db, {
      providerId: provider.id,
      model,
      providerLimit: provider.max_concurrency,
      routeLimit: provider.route_max_concurrency,
    })
    if (permit) trackPermit(permit)
    return permit
  }

  const logLeaseLost = async (provider: RoutedProvider): Promise<Response> => {
    await insertLog(event, {
      ...base,
      providerId: provider.id,
      providerName: provider.name,
      status: 503,
      durationMs: Math.round(performance.now() - t0),
      error: sanitizeError('concurrency lease lost'),
    })
    return concurrencyStateUnavailable()
  }

  const invalidateOwnedBinding = async (providerId: number): Promise<Response | null> => {
    if (
      !affinityKey ||
      !mayMutateAffinity ||
      !affinityBinding?.owned ||
      affinityBinding.providerId !== providerId
    ) {
      return null
    }

    const ownedBinding = affinityBinding
    let invalidated: boolean
    try {
      invalidated = await invalidateAffinityProvider(db, affinityKey, ownedBinding)
    } catch {
      return routingStateUnavailable()
    }
    affinityBinding = null
    if (!invalidated) mayMutateAffinity = false
    return null
  }

  // 只保留最近一次 alias 编码，避免相同上游模型重试时重复序列化，也不按 provider 累积大请求体。
  let encodedModel = requestedModel
  let encodedBody: BodyInit = rawBody
  while (true) {
    let provider: RoutedProvider | null = null
    let permit: ConcurrencyPermit | null = null

    // Resolve an existing or concurrently-won sticky binding before considering priority order.
    while (affinityKey && mayMutateAffinity && affinityBinding) {
      coordinationSteps += 1
      if (coordinationSteps > maxCoordinationSteps) return routingStateUnavailable()

      const boundProvider = providerById.get(affinityBinding.providerId)
      if (!boundProvider) {
        const staleBinding = affinityBinding
        let invalidated: boolean
        try {
          invalidated = await invalidateAffinityProvider(db, affinityKey, staleBinding)
          affinityBinding = invalidated
            ? null
            : await getAffinityBinding(db, affinityKey, Date.now())
        } catch {
          return routingStateUnavailable()
        }
        continue
      }

      // A provider is attempted at most once by this request, including under claim races.
      if (triedProviderIds.has(boundProvider.id)) return routingStateUnavailable()

      try {
        permit = await acquire(boundProvider)
      } catch {
        return routingStateUnavailable()
      }
      if (!permit) {
        return gatewayError(
          429,
          'session provider is at concurrency limit',
          'rate_limit_error',
        )
      }

      let claimed: AffinityBinding
      try {
        claimed = await claimAffinityProvider(db, affinityKey, boundProvider.id, Date.now())
      } catch {
        await permit.release()
        return routingStateUnavailable()
      }
      if (claimed.providerId === boundProvider.id && claimed.owned) {
        affinityBinding = claimed
        provider = boundProvider
        break
      }

      await permit.release()
      permit = null
      affinityBinding = claimed
    }

    if (!provider || !permit) {
      let redirectedToWinner = false

      // Cold/non-sticky requests follow priority, skipping candidates whose capacity is full.
      for (const candidate of candidates) {
        if (triedProviderIds.has(candidate.id)) continue

        try {
          permit = await acquire(candidate)
        } catch {
          return routingStateUnavailable()
        }
        if (!permit) continue

        if (affinityKey && mayMutateAffinity) {
          coordinationSteps += 1
          if (coordinationSteps > maxCoordinationSteps) {
            await permit.release()
            return routingStateUnavailable()
          }

          let claimed: AffinityBinding
          try {
            claimed = await claimAffinityProvider(db, affinityKey, candidate.id, Date.now())
          } catch {
            await permit.release()
            return routingStateUnavailable()
          }
          if (claimed.providerId !== candidate.id || !claimed.owned) {
            await permit.release()
            permit = null
            affinityBinding = claimed
            redirectedToWinner = true
            break
          }
          affinityBinding = claimed
        }

        provider = candidate
        break
      }

      if ((!provider || !permit) && redirectedToWinner) continue
      if (!provider || !permit) {
        if (attemptedUpstream) {
          return gatewayError(502, 'all providers failed', 'api_error')
        }
        return gatewayError(
          429,
          `all providers are at concurrency limit for model ${model}`,
          'rate_limit_error',
        )
      }
    }

    if (permit.lost()) {
      await permit.release()
      return logLeaseLost(provider)
    }

    const leaseSignal = permit.signal
      ? AbortSignal.any([event.req.signal, permit.signal])
      : event.req.signal
    const signal = stream ? leaseSignal : upstreamTimeout(provider, leaseSignal)
    triedProviderIds.add(provider.id)
    attemptedUpstream = true

    // alias 映射（或 provider/model 显式选择）导致上游模型 id 与客户端请求不同时，重写 body 里的 model 字段
    if (provider.upstream_model !== requestedModel && provider.upstream_model !== encodedModel) {
      encodedBody = new TextEncoder().encode(JSON.stringify({ ...body, model: provider.upstream_model }))
      encodedModel = provider.upstream_model
    }
    const upstreamBody = provider.upstream_model === requestedModel ? rawBody : encodedBody
    let res: Response | null = null
    let fetchErr: string | null = null
    // TTFT 计时起点：从发起上游连接起算；此前的 body 解析、路由、并发租约等网关内部处理不计入
    const upstreamStart = performance.now()
    try {
      res = await fetch(provider.base_url + opts.path, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${provider.api_key}`,
          'content-type': 'application/json',
          'accept-encoding': 'identity',
        },
        body: upstreamBody,
        signal,
      })
    } catch (err) {
      fetchErr = err instanceof Error ? err.message : String(err)
    }

    if (!res) {
      const leaseLost = permit.lost()
      await permit.release()
      if (leaseLost) return logLeaseLost(provider)

      await insertLog(event, {
        ...base,
        providerId: provider.id,
        providerName: provider.name,
        status: 502,
        durationMs: Math.round(performance.now() - t0),
        error: sanitizeError(`${provider.name}: ${fetchErr}`),
        reqBody: clientReqBody,
      })
      const stateError = await invalidateOwnedBinding(provider.id)
      if (stateError) return stateError
      continue
    }

    if (permit.lost()) {
      await cancelBody(res.body)
      await permit.release()
      return logLeaseLost(provider)
    }

    if (res.status >= 500) {
      const respBody = await readBodyText(res.body)
      const leaseLost = permit.lost()
      await permit.release()
      if (leaseLost) return logLeaseLost(provider)

      await insertLog(event, {
        ...base,
        providerId: provider.id,
        providerName: provider.name,
        status: res.status,
        durationMs: Math.round(performance.now() - t0),
        error: sanitizeError(`${provider.name}: ${res.status}`),
        reqBody: clientReqBody,
        respBody,
      })
      const stateError = await invalidateOwnedBinding(provider.id)
      if (stateError) return stateError
      continue
    }

    if (res.status >= 400) {
      if (permit.lost()) {
        await cancelBody(res.body)
        await permit.release()
        return logLeaseLost(provider)
      }
      if (!res.body) {
        await permit.release()
        await insertLog(event, {
          ...base,
          providerId: provider.id,
          providerName: provider.name,
          status: res.status,
          durationMs: Math.round(performance.now() - t0),
          error: sanitizeError(`upstream ${res.status}`),
          reqBody: clientReqBody,
        })
        return res
      }

      const headers = new Headers(res.headers)
      headers.delete('content-length')
      // 透传同时捕获全文；响应体结束后落库完整请求/响应（仅错误请求记录）
      const tap = captureTap(res.body)
      const durationMs = Math.round(performance.now() - t0)
      event.waitUntil(
        (async () => {
          const respBody = await tap.text
          await permit.release()
          await insertLog(event, {
            ...base,
            providerId: provider.id,
            providerName: provider.name,
            status: res.status,
            durationMs,
            error: sanitizeError(`upstream ${res.status}`),
            reqBody: clientReqBody,
            respBody,
          })
        })(),
      )
      return new Response(tap.stream, {
        status: res.status,
        statusText: res.statusText,
        headers,
      })
    }

    if (!stream) {
      let buf: ArrayBuffer | null = null
      let bodyError: string | null = null
      let bodyAt = 0
      try {
        buf = await res.arrayBuffer()
        bodyAt = performance.now()
      } catch (err) {
        bodyError = err instanceof Error ? err.message : String(err)
      } finally {
        await permit.release()
      }

      if (permit.lost()) return logLeaseLost(provider)
      if (!buf) {
        await insertLog(event, {
          ...base,
          providerId: provider.id,
          providerName: provider.name,
          status: 502,
          durationMs: Math.round(performance.now() - t0),
          error: sanitizeError(`${provider.name}: ${bodyError}`),
          reqBody: clientReqBody,
        })
        const stateError = await invalidateOwnedBinding(provider.id)
        if (stateError) return stateError
        continue
      }

      let usageRaw: unknown = null
      try {
        const parsed = JSON.parse(new TextDecoder().decode(buf)) as { usage?: unknown }
        usageRaw = parsed.usage ?? null
      } catch {
        // usage 解析失败不影响透传
      }
      const durationMs = Math.round(performance.now() - t0)
      // 非流式首/尾 token 同时到达：TTFT = 上游起点 → 完整响应到达
      const ttftMs = Math.round(bodyAt - upstreamStart)
      const usage =
        opts.protocol === 'chat'
          ? normalizeChatUsage(usageRaw)
          : normalizeResponsesUsage(usageRaw)
      const price = await db.get<PriceRow>(
        'SELECT * FROM prices WHERE model = ? AND provider_id = ?',
        model,
        provider.id,
      )
      const cost = computeCost(usage, price)
      const tps = calcTps(usage.completion, durationMs, null, false)
      const headers = new Headers(res.headers)
      headers.delete('content-length')
      event.waitUntil(
        insertLog(event, {
          ...base,
          providerId: provider.id,
          providerName: provider.name,
          status: res.status,
          usage,
          ttftMs,
          durationMs,
          tps,
          cost,
        }),
      )
      return new Response(buf, {
        status: res.status,
        statusText: res.statusText,
        headers,
      })
    }

    if (!res.body) {
      await permit.release()
      await insertLog(event, {
        ...base,
        providerId: provider.id,
        providerName: provider.name,
        status: 502,
        durationMs: Math.round(performance.now() - t0),
        error: sanitizeError(`${provider.name}: empty response body`),
        reqBody: clientReqBody,
      })
      const stateError = await invalidateOwnedBinding(provider.id)
      if (stateError) return stateError
      continue
    }
    if (permit.lost()) {
      await cancelBody(res.body)
      await permit.release()
      return logLeaseLost(provider)
    }

    // tap owns source.pipeTo(writable); permit release happens before billing/logging I/O.
    const tap = createSseTap(opts.protocol, res.body)
    const headers = new Headers(res.headers)
    headers.delete('content-length')
    const out = new Response(tap.stream.readable, {
      status: res.status,
      statusText: res.statusText,
      headers,
    })
    event.waitUntil(
      (async () => {
        const { usageRaw, error } = await tap.finish()
        await permit.release()
        const endAt = performance.now()
        const durationMs = Math.round(endAt - t0)
        const first = tap.firstChunkAt()
        const ttftMs = first !== null ? Math.round(first - upstreamStart) : null
        const usage =
          opts.protocol === 'chat'
            ? normalizeChatUsage(usageRaw)
            : normalizeResponsesUsage(usageRaw)
        const price = await db.get<PriceRow>(
          'SELECT * FROM prices WHERE model = ? AND provider_id = ?',
          model,
          provider.id,
        )
        const cost = computeCost(usage, price)
        // tps 分母同样以上游起点计，保持「流结束 − 首 chunk」生成窗口语义不变
        const tps = calcTps(usage.completion, Math.round(endAt - upstreamStart), ttftMs, true)
        const finalError = permit.lost() ? 'concurrency lease lost' : error
        await insertLog(event, {
          ...base,
          providerId: provider.id,
          providerName: provider.name,
          status: res.status,
          usage,
          ttftMs,
          durationMs,
          tps,
          cost,
          error: finalError !== null ? sanitizeError(finalError) : null,
        })
      })(),
    )
    return out
  }
}
