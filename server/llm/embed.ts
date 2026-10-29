import { getRequestIP, type H3Event } from 'h3'
import { getDb } from '../db/index.ts'
import { sanitizeError } from '../lib/sanitize.ts'
import { upstreamTimeout } from '../lib/timeout.ts'
import { evalTransform } from '../lib/transform.ts'
import { gatewayError } from '../../shared/api.ts'
import { acquireQueuedConcurrency, type ConcurrencyPermit } from './concurrency.ts'
import type { RoutedProvider } from './router.ts'
import { normalizeEmbeddingUsage, type NormalizedUsage } from './usage.ts'
import {
  cancelBody,
  concurrencyStateUnavailable,
  detailText,
  readBodyText,
  readRelayRequestBody,
  resolveRelayRoute,
  trackPermit,
} from './relay-support.ts'

interface EmbeddingLogEntry {
  apiKeyId: number
  model: string
  providerId: number
  providerName: string
  status: number
  durationMs: number
  /** 缺省时回退为 durationMs（错误路径维持旧行为） */
  ttftMs?: number | null
  usage?: NormalizedUsage
  error?: string | null
  clientIp: string | null
  /** 仅错误请求（最终状态非 200）记录；正常请求省略 → NULL */
  reqBody?: string | null
  respBody?: string | null
}

async function insertLog(event: H3Event, row: EmbeddingLogEntry): Promise<void> {
  const usage = row.usage ?? { prompt: 0, completion: 0, cached: 0, total: 0 }
  await getDb(event).run(
    `INSERT INTO llm_logs (
       api_key_id, protocol, model, provider_id, provider_name, stream, status,
       prompt_tokens, completion_tokens, cached_tokens, total_tokens,
       ttft_ms, duration_ms, tps, cost, error, client_ip, req_body, resp_body
     ) VALUES (?, 'embedding', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    row.apiKeyId,
    row.model,
    row.providerId,
    row.providerName,
    row.status,
    usage.prompt,
    usage.completion,
    usage.cached,
    usage.total,
    row.ttftMs ?? row.durationMs,
    row.durationMs,
    // embedding 不计费：cost 恒 0
    0,
    row.error ?? null,
    row.clientIp,
    row.reqBody ?? null,
    row.respBody ?? null,
  )
}

export async function relayEmbeddings(event: H3Event): Promise<Response> {
  // 认证由父级 app.ts 挂载的 app.use('/v1/**', apiKeyMw) 完成，到达此处的请求必然带 apiKeyId。
  const apiKeyId = event.context.apiKeyId as number

  const clientIp = getRequestIP(event) ?? null
  const t0 = performance.now()

  const request = await readRelayRequestBody(event)
  if (request instanceof Response) return request
  const { rawBody, body, text: clientReqBody } = request
  const requestedModel = request.model

  const db = getDb(event)
  const route = await resolveRelayRoute(db, requestedModel, 'embedding')
  if (route instanceof Response) return route
  const { model, candidates } = route

  const base = { apiKeyId, model, clientIp }
  let attemptedProvider = false

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

  for (const provider of candidates) {
    let permit: ConcurrencyPermit | null
    try {
      // embedding 响应整体缓冲、无字节转发风险，满员时短暂排队等待空槽，
      // 超时仍未拿到租约才 continue 到下一候选（chat/responses 保持即取即走）
      permit = await acquireQueuedConcurrency(
        db,
        {
          providerId: provider.id,
          model,
          providerLimit: provider.max_concurrency,
          routeLimit: provider.route_max_concurrency,
        },
        event.req.signal,
      )
    } catch {
      return concurrencyStateUnavailable()
    }
    if (!permit) continue
    trackPermit(event, permit)
    attemptedProvider = true

    // alias 映射（或 provider/model 显式选择）导致上游模型 id 与客户端请求不同时，重写 body 里的 model 字段
    const bodyForProvider =
      provider.upstream_model !== requestedModel ? { ...body, model: provider.upstream_model } : body
    let upstreamBody: BodyInit =
      provider.upstream_model !== requestedModel
        ? new TextEncoder().encode(JSON.stringify(bodyForProvider))
        : rawBody
    if (provider.type === 'embedding' && provider.transform_code !== '') {
      try {
        const transformed = await evalTransform(provider.transform_code, bodyForProvider)
        upstreamBody = new TextEncoder().encode(JSON.stringify(transformed))
      } catch (error) {
        const leaseLost = permit.signal.aborted
        await permit.release()
        if (leaseLost) return logLeaseLost(provider)
        const message = error instanceof Error ? error.message : String(error)
        await insertLog(event, {
          ...base,
          providerId: provider.id,
          providerName: provider.name,
          status: 502,
          durationMs: Math.round(performance.now() - t0),
          error: sanitizeError(`${provider.name}: request transform failed: ${message}`),
          reqBody: clientReqBody,
        })
        continue
      }
    }

    if (permit.signal.aborted) {
      await permit.release()
      return logLeaseLost(provider)
    }

    const leaseSignal = AbortSignal.any([event.req.signal, permit.signal])
    let res: Response | null = null
    let fetchError: string | null = null
    // TTFT 计时起点：从发起上游连接起算；此前的路由、并发排队、transform 等内部处理不计入
    const upstreamStart = performance.now()
    try {
      res = await fetch(provider.base_url + '/embeddings', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${provider.api_key}`,
          'content-type': 'application/json',
          'accept-encoding': 'identity',
        },
        body: upstreamBody,
        signal: upstreamTimeout(provider, leaseSignal),
      })
    } catch (error) {
      fetchError = error instanceof Error ? error.message : String(error)
    }

    if (!res) {
      const leaseLost = permit.signal.aborted
      await permit.release()
      if (leaseLost) return logLeaseLost(provider)
      await insertLog(event, {
        ...base,
        providerId: provider.id,
        providerName: provider.name,
        status: 502,
        durationMs: Math.round(performance.now() - t0),
        error: sanitizeError(`${provider.name}: ${fetchError}`),
        reqBody: clientReqBody,
      })
      continue
    }

    if (permit.signal.aborted) {
      await cancelBody(res.body)
      await permit.release()
      return logLeaseLost(provider)
    }

    if (res.status >= 500) {
      const respBody = await readBodyText(res.body)
      const leaseLost = permit.signal.aborted
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
      continue
    }

    let responseBuffer: ArrayBuffer | null = null
    let responseError: string | null = null
    let bodyAt = 0
    try {
      responseBuffer = await res.arrayBuffer()
      bodyAt = performance.now()
    } catch (error) {
      responseError = error instanceof Error ? error.message : String(error)
    } finally {
      await permit.release()
    }

    if (permit.signal.aborted) return logLeaseLost(provider)
    if (!responseBuffer) {
      await insertLog(event, {
        ...base,
        providerId: provider.id,
        providerName: provider.name,
        status: 502,
        durationMs: Math.round(performance.now() - t0),
        error: sanitizeError(`${provider.name}: ${responseError}`),
        reqBody: clientReqBody,
      })
      continue
    }

    const headers = new Headers(res.headers)
    headers.delete('content-length')
    if (res.status >= 400) {
      await insertLog(event, {
        ...base,
        providerId: provider.id,
        providerName: provider.name,
        status: res.status,
        durationMs: Math.round(performance.now() - t0),
        error: sanitizeError(`upstream ${res.status}`),
        reqBody: clientReqBody,
        respBody: detailText(responseBuffer),
      })
      return new Response(responseBuffer, {
        status: res.status,
        statusText: res.statusText,
        headers,
      })
    }

    let responseObject: unknown = null
    let outgoingBody: BodyInit = responseBuffer
    if (provider.type === 'embedding' && provider.transform_code !== '') {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(responseBuffer)) as unknown
        responseObject = await evalTransform(provider.transform_code, parsed)
        outgoingBody = new TextEncoder().encode(JSON.stringify(responseObject ?? null))
        headers.delete('content-encoding')
        headers.delete('content-md5')
        headers.delete('content-range')
        headers.delete('digest')
        headers.delete('etag')
        headers.delete('last-modified')
        headers.set('content-type', 'application/json')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await insertLog(event, {
          ...base,
          providerId: provider.id,
          providerName: provider.name,
          status: 502,
          durationMs: Math.round(performance.now() - t0),
          error: sanitizeError(`${provider.name}: response transform failed: ${message}`),
          reqBody: clientReqBody,
          respBody: detailText(responseBuffer),
        })
        continue
      }
    } else {
      try {
        responseObject = JSON.parse(new TextDecoder().decode(responseBuffer)) as unknown
      } catch {
        // Usage parsing failure does not affect passthrough.
      }
    }

    let usageRaw: unknown = null
    if (responseObject !== null && typeof responseObject === 'object' && !Array.isArray(responseObject)) {
      const responseRecord = responseObject as Record<string, unknown>
      usageRaw = responseRecord.usage ?? responseRecord
    }
    const durationMs = Math.round(performance.now() - t0)
    const usage = normalizeEmbeddingUsage(usageRaw)
    // embedding 不计费（决策）：只记录 token 用量，不写价格
    event.waitUntil(
      insertLog(event, {
        ...base,
        providerId: provider.id,
        providerName: provider.name,
        status: res.status,
        durationMs,
        ttftMs: Math.round(bodyAt - upstreamStart),
        usage,
      }),
    )
    return new Response(outgoingBody, {
      status: res.status,
      statusText: res.statusText,
      headers,
    })
  }

  if (attemptedProvider) {
    return gatewayError(502, 'all providers failed', 'api_error')
  }
  return gatewayError(
    429,
    `all providers are at concurrency limit for model ${model}`,
    'rate_limit_error',
  )
}
