import type { H3 } from 'h3'
import { HTTPError, getQuery } from 'h3'
import { requireAdmin } from '../auth.ts'
import { getDb } from '../db/index.ts'
import { mustGet, normalizeTs, pagingParams, routeId } from './common.ts'
import type { LlmLogRow, Paged } from '../../shared/api.ts'

export function registerLogs(app: H3): void {
  // 请求日志：分页 + 过滤，ts 倒序
  app.get('/api/admin/logs', async (event) => {
    requireAdmin(event)
    const db = getDb(event)
    const q = getQuery(event)

    const { limit, offset } = pagingParams(event)

    // WHERE 动态拼接，参数全部走绑定
    const where: string[] = []
    const params: (string | number)[] = []
    if (typeof q.model === 'string' && q.model) {
      where.push('model LIKE ?')
      params.push(`%${q.model}%`)
    }
    if (q.protocol === 'chat' || q.protocol === 'responses' || q.protocol === 'embedding') {
      where.push('protocol = ?')
      params.push(q.protocol)
    }
    const providerId = Number(q.providerId)
    if (Number.isInteger(providerId) && providerId > 0) {
      where.push('provider_id = ?')
      params.push(providerId)
    }
    const status = Number(q.status)
    if (Number.isInteger(status) && status >= 0) {
      where.push('status = ?')
      params.push(status)
    }
    if (typeof q.from === 'string' && q.from) {
      where.push('ts >= ?')
      params.push(normalizeTs(q.from))
    }
    if (typeof q.to === 'string' && q.to) {
      where.push('ts <= ?')
      params.push(normalizeTs(q.to))
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''

    const totalRow = await mustGet<{ total: number }>(
      db,
      `SELECT count(*) AS total FROM llm_logs${whereSql}`,
      ...params,
    )
    const rows = await db.all<LlmLogRow>(
      `SELECT * FROM llm_logs${whereSql} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    )
    const result: Paged<LlmLogRow> = { rows, total: totalRow.total }
    return result
  })

  // 单条日志详情（含 req_body/resp_body，仅错误请求有值）
  app.get('/api/admin/logs/:id', async (event) => {
    requireAdmin(event)
    const id = routeId(event)
    const row = await getDb(event).get<LlmLogRow>(`SELECT * FROM llm_logs WHERE id = ?`, id)
    if (!row) throw new HTTPError({ status: 404, message: 'log not found' })
    return row
  })
}
