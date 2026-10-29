import type { H3 } from 'h3'
import { getQuery } from 'h3'
import { requireAdmin } from '../auth.ts'
import { getDb } from '../db/index.ts'
import { mustGet, normalizeTs } from './common.ts'
import type { StatsResult } from '../../shared/api.ts'

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
/** 显式分桶粒度白名单（秒）；缺失/非法时按查询范围推导 */
const EXPLICIT_BUCKETS = ['60', '1800', '10800', '43200']

/** 聚合查询结果行（llm_logs 单表聚合） */
interface TotalsRow {
  requests: number
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number
  total_tokens: number
  cost: number
  avg_ttft_ms: number | null
  avg_tps: number | null
}

/** Date → SQLite datetime 串（UTC，与 datetime('now') 同格式） */
function formatTs(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

export function registerStats(app: H3): void {
  // 统计：总数聚合 + 按模型分桶 + token 流向（默认最近 24h）
  app.get('/api/admin/stats', async (event) => {
    requireAdmin(event)
    const db = getDb(event)
    const q = getQuery(event)

    // 默认统计最近 24 小时；也可显式传 from/to（ISO 或 SQLite datetime 串）
    const now = new Date()
    const from = typeof q.from === 'string' && q.from !== '' ? q.from : formatTs(new Date(now.getTime() - DAY))
    const to = typeof q.to === 'string' && q.to !== '' ? q.to : formatTs(now)

    const whereSql = ` WHERE ts >= ? AND ts <= ?`
    const params: string[] = [normalizeTs(from), normalizeTs(to)]

    // 分桶粒度（秒）：显式 bucket 仅接受白名单内的整数；缺失/非法时按范围推导 1h→60 / 24h→1800 / 7d→10800 / 30d→43200
    const fromMs = Date.parse(from.replace(' ', 'T'))
    const toMs = Date.parse(to.replace(' ', 'T'))
    const durationMs = Number.isFinite(fromMs) && Number.isFinite(toMs) ? toMs - fromMs : NaN
    let bucket: number
    if (typeof q.bucket === 'string' && EXPLICIT_BUCKETS.includes(q.bucket)) {
      bucket = Number(q.bucket)
    } else if (Number.isFinite(durationMs) && durationMs <= HOUR) {
      bucket = 60
    } else if (Number.isFinite(durationMs) && durationMs <= DAY) {
      bucket = 1800
    } else if (Number.isFinite(durationMs) && durationMs <= 7 * DAY) {
      bucket = 10800
    } else {
      bucket = 43200
    }

    // 固定 UTC 秒级窗口分桶，显式保留 Z 时区；bucket 走参数绑定，不参与字符串拼接
    const bucketExpr = `strftime('%Y-%m-%dT%H:%M:00Z', (cast(strftime('%s', ts) as integer) / cast(? as integer)) * cast(? as integer), 'unixepoch')`

    const totals = await mustGet<TotalsRow>(
      db,
      `SELECT count(*) AS requests,
              coalesce(sum(prompt_tokens), 0) AS prompt_tokens,
              coalesce(sum(completion_tokens), 0) AS completion_tokens,
              coalesce(sum(cached_tokens), 0) AS cached_tokens,
              coalesce(sum(total_tokens), 0) AS total_tokens,
              coalesce(sum(cost), 0) AS cost,
              avg(CASE WHEN stream = 1 THEN ttft_ms END) AS avg_ttft_ms,
              avg(tps) AS avg_tps
       FROM llm_logs${whereSql}`,
      ...params,
    )

    const modelBuckets = await db.all<{
      bucket: string
      model: string
      requests: number
      cost: number
      tokens: number
    }>(
      `SELECT ${bucketExpr} AS bucket, model, count(*) AS requests,
              coalesce(sum(cost), 0) AS cost, coalesce(sum(total_tokens), 0) AS tokens
       FROM llm_logs${whereSql}
       GROUP BY bucket, model ORDER BY bucket, model`,
      bucket,
      bucket,
      ...params,
    )

    const tokenFlows = await db.all<{
      model: string
      provider_id: number | null
      provider_name: string
      total_tokens: number
      requests: number
      cost: number
      prompt_tokens: number
      cached_tokens: number
    }>(
      `SELECT model, provider_id,
              coalesce(nullif(trim(provider_name), ''), 'Unknown') AS provider_name,
              coalesce(sum(total_tokens), 0) AS total_tokens,
              count(*) AS requests,
              coalesce(sum(cost), 0) AS cost,
              coalesce(sum(prompt_tokens), 0) AS prompt_tokens,
              coalesce(sum(cached_tokens), 0) AS cached_tokens
       FROM llm_logs${whereSql} AND total_tokens > 0
       GROUP BY model, provider_id, coalesce(nullif(trim(provider_name), ''), 'Unknown')
       HAVING sum(total_tokens) > 0
       ORDER BY model, provider_name`,
      ...params,
    )

    const result: StatsResult = {
      totals,
      modelBuckets: modelBuckets.map((b) => ({
        ts: b.bucket,
        model: b.model,
        requests: b.requests,
        cost: b.cost,
        tokens: b.tokens,
      })),
      tokenFlows: tokenFlows.map((flow) => ({
        model: flow.model,
        provider_id: flow.provider_id,
        provider_name: flow.provider_name,
        total_tokens: flow.total_tokens,
        requests: flow.requests,
        cost: flow.cost,
        prompt_tokens: flow.prompt_tokens,
        cached_tokens: flow.cached_tokens,
      })),
    }
    return result
  })
}
