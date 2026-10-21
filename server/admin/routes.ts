import type { H3 } from 'h3'
import { HTTPError, readBody } from 'h3'
import { z } from 'zod'
import { requireAdmin } from '../auth.ts'
import { getDb } from '../db/index.ts'
import type { ModelRouteRow } from '../../shared/api.ts'

/** 按模型配置供应商优先级（priority 1 最高） */
const routeSchema = z.object({
  model: z.string().min(1),
  routes: z.array(
    z.object({
      provider_id: z.number().int().positive(),
      priority: z.number().int().min(1),
      enabled: z.number().int().min(0).max(1),
      max_concurrency: z.number().int().min(0).optional(),
    }),
  ),
})

/** zod 校验失败 → 400 + issues */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new HTTPError({ status: 400, message: 'invalid body', data: parsed.error.issues })
  }
  return parsed.data
}

export function registerRoutes(app: H3): void {
  // 全部路由，JOIN 供应商名
  app.get('/api/admin/routes', async (event) => {
    requireAdmin(event)
    return getDb(event).all<ModelRouteRow & { provider_name: string }>(
      `SELECT r.*, p.name AS provider_name FROM model_routes r
       JOIN providers p ON p.id = r.provider_id
       ORDER BY r.model, r.priority`,
    )
  })

  // 全量替换某模型的供应商优先级列表
  app.put('/api/admin/routes', async (event) => {
    requireAdmin(event)
    const body = parseBody(routeSchema, await readBody(event))
    const db = getDb(event)
    // Db 接口无事务 API（D1 无同步事务），此处先删后插即可
    await db.run(`DELETE FROM model_routes WHERE model = ?`, body.model)
    for (const r of body.routes) {
      await db.run(
        `INSERT INTO model_routes (model, provider_id, priority, enabled, max_concurrency)
         VALUES (?, ?, ?, ?, ?)`,
        body.model,
        r.provider_id,
        r.priority,
        r.enabled,
        r.max_concurrency ?? 0,
      )
    }
    return { ok: true }
  })
}
