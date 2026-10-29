import type { H3Event } from 'h3'
import { HTTPError, getQuery, getRouterParam } from 'h3'
import type { z } from 'zod'
import type { Db, SqlValue } from '../db/types.ts'

/** zod 校验失败 → 400 + issues */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new HTTPError({ status: 400, message: 'invalid body', data: parsed.error.issues })
  }
  return parsed.data
}

/** 路由参数 id 解析（非法 → 400） */
export function routeId(event: H3Event): number {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) throw new HTTPError({ status: 400, message: 'invalid id' })
  return id
}

/** 客户端时间串归一化为 SQLite datetime 格式（'T'→空格、去尾 Z），保证字符串比较一致 */
export function normalizeTs(s: string): string {
  return s.replace('T', ' ').replace(/Z$/i, '')
}

/** 分页参数：page 从 1 开始，pageSize 上限 100（默认 1 / 20） */
export function pagingParams(event: H3Event): { limit: number; offset: number } {
  const q = getQuery(event)
  const page = Math.max(1, Number(q.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20))
  return { limit: pageSize, offset: (page - 1) * pageSize }
}

/** SQLite 的 UNIQUE 冲突（node:sqlite / D1 文本一致） */
export function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /unique constraint failed/i.test(message)
}

/** 必然有结果的查询（写入后回读、count(*) 聚合）：缺行说明数据库状态异常 */
export async function mustGet<T>(db: Db, sql: string, ...params: SqlValue[]): Promise<T> {
  const row = await db.get<T>(sql, ...params)
  if (!row) throw new HTTPError({ status: 500, message: 'failed to read row' })
  return row
}
