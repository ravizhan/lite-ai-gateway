import type { H3 } from 'h3'
import { HTTPError, readBody } from 'h3'
import { z } from 'zod'
import { requireAdmin } from '../auth.ts'
import { getDb } from '../db/index.ts'
import type { PriceRow } from '../../shared/api.ts'

/** 价格按"网关模型名 + 供应商"配置，单位：美元 / 1M tokens */
const priceSchema = z.object({
  provider_id: z.number().int().positive(),
  model: z.string().min(1),
  input_price: z.number().finite().min(0),
  output_price: z.number().finite().min(0),
  cache_read_price: z.number().finite().min(0),
})

/** zod 校验失败 → 400 + issues */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new HTTPError({ status: 400, message: 'invalid body', data: parsed.error.issues })
  }
  return parsed.data
}

export function registerPrices(app: H3): void {
  // 全部价格行
  app.get('/api/admin/prices', async (event) => {
    requireAdmin(event)
    return getDb(event).all<PriceRow>(`SELECT * FROM prices ORDER BY model, provider_id`)
  })

  // 按 model/provider upsert 价格
  app.put('/api/admin/prices', async (event) => {
    requireAdmin(event)
    const body = parseBody(priceSchema, await readBody(event))
    const db = getDb(event)
    const provider = await db.get<{ id: number }>(`SELECT id FROM providers WHERE id = ?`, body.provider_id)
    if (!provider) throw new HTTPError({ status: 404, message: 'provider not found' })
    await db.run(
      `INSERT INTO prices (model, provider_id, input_price, output_price, cache_read_price)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(model, provider_id) DO UPDATE SET
         input_price = excluded.input_price,
         output_price = excluded.output_price,
         cache_read_price = excluded.cache_read_price`,
      body.model,
      body.provider_id,
      body.input_price,
      body.output_price,
      body.cache_read_price,
    )
    const row = await db.get<PriceRow>(
      `SELECT * FROM prices WHERE model = ? AND provider_id = ?`,
      body.model,
      body.provider_id,
    )
    if (!row) throw new HTTPError({ status: 500, message: 'failed to read upserted row' })
    return row
  })
}
