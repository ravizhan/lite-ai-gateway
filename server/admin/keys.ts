import type { H3, H3Event } from 'h3'
import { HTTPError, getRouterParam, readBody } from 'h3'
import { z } from 'zod'
import { requireAdmin } from '../auth.ts'
import { getDb } from '../db/index.ts'
import { generateApiKey } from '../lib/keys.ts'
import type { ApiKeyRow } from '../../shared/api.ts'

const keySchema = z.object({
  name: z.string().min(1),
})

const keyPatchSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.union([z.literal(0), z.literal(1)]).optional(),
})

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

export function registerKeys(app: H3): void {
  // 全部 API key
  app.get('/api/admin/keys', async (event) => {
    requireAdmin(event)
    return getDb(event).all<ApiKeyRow>(`SELECT * FROM api_keys ORDER BY id`)
  })

  // 新建 key（明文仅在此响应中出现一次）
  app.post('/api/admin/keys', async (event) => {
    requireAdmin(event)
    const body = parseBody(keySchema, await readBody(event))
    const db = getDb(event)
    const key = generateApiKey()
    await db.run(`INSERT INTO api_keys (name, key) VALUES (?, ?)`, body.name, key)
    // key 唯一，回查拿完整行（含 created_at）
    const row = await db.get<ApiKeyRow>(`SELECT * FROM api_keys WHERE key = ?`, key)
    if (!row) throw new HTTPError({ status: 500, message: 'failed to read inserted row' })
    return row
  })

  // 更新 key（改名 / 启停用）
  app.put('/api/admin/keys/:id', async (event) => {
    requireAdmin(event)
    const id = routeId(event)
    const body = parseBody(keyPatchSchema, await readBody(event))
    const db = getDb(event)
    const exists = await db.get(`SELECT id FROM api_keys WHERE id = ?`, id)
    if (!exists) throw new HTTPError({ status: 404, message: 'key not found' })
    const sets: string[] = []
    const params: (string | number)[] = []
    if (body.name !== undefined) {
      sets.push('name = ?')
      params.push(body.name)
    }
    if (body.enabled !== undefined) {
      sets.push('enabled = ?')
      params.push(body.enabled)
    }
    if (sets.length > 0) {
      await db.run(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = ?`, ...params, id)
    }
    const row = await db.get<ApiKeyRow>(`SELECT * FROM api_keys WHERE id = ?`, id)
    if (!row) throw new HTTPError({ status: 500, message: 'failed to read updated row' })
    return row
  })

  // 删除 key（即时吊销）
  app.delete('/api/admin/keys/:id', async (event) => {
    requireAdmin(event)
    const id = routeId(event)
    await getDb(event).run(`DELETE FROM api_keys WHERE id = ?`, id)
    return { ok: true }
  })
}
