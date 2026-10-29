import type { H3 } from 'h3'
import { HTTPError, getQuery, readBody } from 'h3'
import { z } from 'zod'
import { requireAdmin } from '../auth.ts'
import { getDb } from '../db/index.ts'
import type { Db } from '../db/types.ts'
import { isUniqueViolation, mustGet, parseBody, routeId } from './common.ts'
import type { ModelRow } from '../../shared/api.ts'

/** 手动补录模型（discovered=0，用于 Gemini/Azure 等无兼容 /models 的供应商） */
const modelSchema = z.object({
  provider_id: z.number().int().positive(),
  model: z.string().min(1),
  alias: z.string().max(255).optional(),
})

const modelPatchSchema = z.object({
  enabled: z.union([z.literal(0), z.literal(1)]).optional(),
  /** 对外模型 id 映射；空串 = 清除映射（回退原始 model） */
  alias: z.string().max(255).optional(),
})

/**
 * 删除模型行，并级联清理该供应商下同一对外 id 的 prices / model_routes 行。
 * 同供应商仍有其他模型行映射到同一对外 id 时保留（配置仍被使用）。
 */
export async function deleteModelRow(db: Db, row: ModelRow): Promise<void> {
  const external = row.alias !== '' ? row.alias : row.model
  await db.run(`DELETE FROM models WHERE id = ?`, row.id)
  const stillUsed = await db.get<{ id: number }>(
    `SELECT id FROM models
     WHERE provider_id = ? AND (alias = ? OR (alias = '' AND model = ?)) LIMIT 1`,
    row.provider_id,
    external,
    external,
  )
  if (!stillUsed) {
    await db.run(`DELETE FROM prices WHERE provider_id = ? AND model = ?`, row.provider_id, external)
    await db.run(`DELETE FROM model_routes WHERE provider_id = ? AND model = ?`, row.provider_id, external)
  }
}

export function registerModels(app: H3): void {
  // 模型列表（可带 ?providerId= 过滤），JOIN 供应商名
  app.get('/api/admin/models', async (event) => {
    requireAdmin(event)
    const db = getDb(event)
    const providerId = Number(getQuery(event).providerId)
    if (Number.isInteger(providerId) && providerId > 0) {
      return db.all<ModelRow & { provider_name: string }>(
        `SELECT m.*, p.name AS provider_name FROM models m
         JOIN providers p ON p.id = m.provider_id
         WHERE m.provider_id = ? ORDER BY p.id, m.model`,
        providerId,
      )
    }
    return db.all<ModelRow & { provider_name: string }>(
      `SELECT m.*, p.name AS provider_name FROM models m
       JOIN providers p ON p.id = m.provider_id
       ORDER BY p.id, m.model`,
    )
  })

  // 手动补录模型
  app.post('/api/admin/models', async (event) => {
    requireAdmin(event)
    const body = parseBody(modelSchema, await readBody(event))
    const db = getDb(event)
    try {
      await db.run(
        `INSERT INTO models (provider_id, model, alias, discovered, enabled) VALUES (?, ?, ?, 0, 1)`,
        body.provider_id,
        body.model,
        body.alias ?? '',
      )
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new HTTPError({ status: 409, message: 'model already exists for this provider' })
      }
      throw err
    }
    return mustGet<ModelRow>(
      db,
      `SELECT * FROM models WHERE provider_id = ? AND model = ?`,
      body.provider_id,
      body.model,
    )
  })

  // 更新模型（启用/禁用、alias 映射）
  app.put('/api/admin/models/:id', async (event) => {
    requireAdmin(event)
    const id = routeId(event)
    const body = parseBody(modelPatchSchema, await readBody(event))
    const db = getDb(event)
    const exists = await db.get(`SELECT id FROM models WHERE id = ?`, id)
    if (!exists) throw new HTTPError({ status: 404, message: 'model not found' })
    const sets: string[] = []
    const params: (string | number)[] = []
    if (body.enabled !== undefined) {
      sets.push('enabled = ?')
      params.push(body.enabled)
    }
    if (body.alias !== undefined) {
      sets.push('alias = ?')
      params.push(body.alias.trim())
    }
    if (sets.length > 0) {
      await db.run(`UPDATE models SET ${sets.join(', ')} WHERE id = ?`, ...params, id)
    }
    return mustGet<ModelRow>(db, `SELECT * FROM models WHERE id = ?`, id)
  })

  // 删除模型（级联规则见 deleteModelRow）
  app.delete('/api/admin/models/:id', async (event) => {
    requireAdmin(event)
    const id = routeId(event)
    const db = getDb(event)
    const row = await db.get<ModelRow>(`SELECT * FROM models WHERE id = ?`, id)
    if (!row) throw new HTTPError({ status: 404, message: 'model not found' })
    await deleteModelRow(db, row)
    return { ok: true }
  })
}
