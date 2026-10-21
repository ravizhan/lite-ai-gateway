import type { H3, H3Event } from 'h3'
import { HTTPError, getRouterParam, readBody } from 'h3'
import { z } from 'zod'
import { requireAdmin } from '../auth.ts'
import { getDb } from '../db/index.ts'
import { sanitizeError } from '../lib/sanitize.ts'
import { discoveryTimeout } from '../lib/timeout.ts'
import { checkTransform } from '../lib/transform.ts'
import type { DiscoverResult, ProviderRow } from '../../shared/api.ts'

/** 供应商字段 schema（POST 全必填；PUT 用 partial 全可选） */
const providerSchema = z.object({
  name: z.string().min(1),
  base_url: z.url(),
  api_key: z.string().min(1),
  type: z.enum(['llm', 'embedding']).optional(),
  enabled: z.union([z.literal(0), z.literal(1)]).optional(),
  supports_responses: z.union([z.literal(0), z.literal(1)]).optional(),
  timeout_ms: z.number().int().min(0).optional(),
  max_concurrency: z.number().int().min(0).optional(),
  transform_code: z.string().max(64 * 1024).optional(),
})
const providerPatchSchema = providerSchema.partial()

/** GET {base}/models 响应（仅取模型 id 列表） */
const discoverPayloadSchema = z.object({
  data: z.array(z.object({ id: z.union([z.string(), z.number()]) })),
})

/** base_url 归一化：去掉尾部斜杠 */
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

/** zod 校验失败 → 400 + issues */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new HTTPError({ status: 400, message: 'invalid body', data: parsed.error.issues })
  }
  return parsed.data
}

/** 路由参数 id 解析（非法 → 400） */
function routeId(event: H3Event): number {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) throw new HTTPError({ status: 400, message: 'invalid id' })
  return id
}

export function registerProviders(app: H3): void {
  // 供应商列表：带每个供应商的模型数（单条聚合 SQL）
  app.get('/api/admin/providers', async (event) => {
    requireAdmin(event)
    const db = getDb(event)
    return db.all<ProviderRow & { model_count: number }>(
      `SELECT p.*, (SELECT count(*) FROM models m WHERE m.provider_id = p.id) AS model_count
       FROM providers p ORDER BY p.id`,
    )
  })

  // 新建供应商
  app.post('/api/admin/providers', async (event) => {
    requireAdmin(event)
    const body = parseBody(providerSchema, await readBody(event))
    const type = body.type ?? 'llm'
    if (type === 'embedding' && body.transform_code !== undefined && body.transform_code !== '') {
      const probe = await checkTransform(body.transform_code)
      if (probe !== null) {
        throw new HTTPError({ status: 400, message: sanitizeError('invalid transform_code: ' + probe) })
      }
    }
    const db = getDb(event)
    await db.run(
      `INSERT INTO providers
         (name, base_url, api_key, type, enabled, supports_responses, timeout_ms, max_concurrency, transform_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      body.name,
      normalizeBaseUrl(body.base_url),
      body.api_key,
      type,
      body.enabled ?? 1,
      type === 'llm' ? (body.supports_responses ?? 0) : 0,
      body.timeout_ms ?? 0,
      body.max_concurrency ?? 0,
      type === 'embedding' ? (body.transform_code ?? '') : '',
    )
    // name 唯一，回查拿完整行（含 created_at）
    const row = await db.get<ProviderRow>(`SELECT * FROM providers WHERE name = ?`, body.name)
    if (!row) throw new HTTPError({ status: 500, message: 'failed to read inserted row' })
    return row
  })

  // 更新供应商（仅更新出现的字段）
  app.put('/api/admin/providers/:id', async (event) => {
    requireAdmin(event)
    const id = routeId(event)
    const body = parseBody(providerPatchSchema, await readBody(event))
    const db = getDb(event)
    const current = await db.get<ProviderRow>(`SELECT * FROM providers WHERE id = ?`, id)
    if (!current) throw new HTTPError({ status: 404, message: 'provider not found' })

    const type = body.type ?? current.type
    if (type === 'embedding' && body.transform_code !== undefined && body.transform_code !== '') {
      const probe = await checkTransform(body.transform_code)
      if (probe !== null) {
        throw new HTTPError({ status: 400, message: sanitizeError('invalid transform_code: ' + probe) })
      }
    }
    const typeChanged = body.type !== undefined && body.type !== current.type
    const sets: string[] = []
    const params: (string | number)[] = []
    if (body.name !== undefined) {
      sets.push('name = ?')
      params.push(body.name)
    }
    if (body.base_url !== undefined) {
      sets.push('base_url = ?')
      params.push(normalizeBaseUrl(body.base_url))
    }
    if (body.api_key !== undefined) {
      sets.push('api_key = ?')
      params.push(body.api_key)
    }
    if (body.type !== undefined) {
      sets.push('type = ?')
      params.push(type)
    }
    if (body.enabled !== undefined) {
      sets.push('enabled = ?')
      params.push(body.enabled)
    }
    if (body.supports_responses !== undefined || typeChanged) {
      sets.push('supports_responses = ?')
      params.push(type === 'llm' ? (body.supports_responses ?? current.supports_responses) : 0)
    }
    if (body.timeout_ms !== undefined) {
      sets.push('timeout_ms = ?')
      params.push(body.timeout_ms)
    }
    if (body.max_concurrency !== undefined) {
      sets.push('max_concurrency = ?')
      params.push(body.max_concurrency)
    }
    if (body.transform_code !== undefined || typeChanged) {
      sets.push('transform_code = ?')
      params.push(type === 'embedding' ? (body.transform_code ?? current.transform_code) : '')
    }
    if (sets.length > 0) {
      await db.run(`UPDATE providers SET ${sets.join(', ')} WHERE id = ?`, ...params, id)
    }
    const row = await db.get<ProviderRow>(`SELECT * FROM providers WHERE id = ?`, id)
    if (!row) throw new HTTPError({ status: 500, message: 'failed to read updated row' })
    return row
  })

  // 删除供应商（models / model_routes 靠外键级联删除）
  app.delete('/api/admin/providers/:id', async (event) => {
    requireAdmin(event)
    const id = routeId(event)
    await getDb(event).run(`DELETE FROM providers WHERE id = ?`, id)
    return { ok: true }
  })

  // 模型发现：GET {base}/models → upsert models（discovered=1），错误文本过 sanitizeError
  app.post('/api/admin/providers/:id/discover', async (event) => {
    requireAdmin(event)
    const id = routeId(event)
    const db = getDb(event)
    const provider = await db.get<ProviderRow>(`SELECT * FROM providers WHERE id = ?`, id)
    if (!provider) throw new HTTPError({ status: 404, message: 'provider not found' })
    let list: string[]
    try {
      const res = await fetch(`${normalizeBaseUrl(provider.base_url)}/models`, {
        headers: { Authorization: `Bearer ${provider.api_key}` },
        signal: discoveryTimeout(provider.timeout_ms),
      })
      if (!res.ok) {
        const summary = sanitizeError(await res.text())
        throw new HTTPError({ status: 502, message: `upstream ${res.status}: ${summary}` })
      }
      const parsedPayload = discoverPayloadSchema.safeParse(await res.json())
      if (!parsedPayload.success) {
        throw new HTTPError({ status: 502, message: 'upstream returned invalid /models payload' })
      }
      list = parsedPayload.data.data.map((m) => String(m.id))
    } catch (err) {
      if (err instanceof HTTPError) throw err
      // 网络错误 / 超时等 → 502，错误文本过 sanitizeError
      throw new HTTPError({ status: 502, message: sanitizeError(String(err)) })
    }
    let added = 0
    for (const model of list) {
      const r = await db.run(
        `INSERT OR IGNORE INTO models (provider_id, model, discovered, enabled) VALUES (?, ?, 1, 1)`,
        id,
        model,
      )
      added += r.changes
    }
    const row = await db.get<{ total: number }>(`SELECT count(*) AS total FROM models WHERE provider_id = ?`, id)
    const result: DiscoverResult = { added, total: row?.total ?? 0 }
    return result
  })
}
