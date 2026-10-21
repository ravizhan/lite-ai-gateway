import type { Db, SqlValue } from './types.ts'

/**
 * D1 适配器（Workers）。查询通过请求级 Sessions API 会话执行，
 * exec 仍使用原始绑定（D1DatabaseSession 不提供 exec）。
 */
export function createD1Db(db: D1Database, session: D1DatabaseSession): Db {
  return {
    async run(sql, ...params) {
      const res = await session.prepare(sql).bind(...params).run()
      return { changes: res.meta.changes }
    },
    async get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T | undefined> {
      const row = await session.prepare(sql).bind(...params).first()
      return (row ?? undefined) as T | undefined
    },
    async all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T[]> {
      const res = await session.prepare(sql).bind(...params).all()
      return res.results as T[]
    },
    async exec(sql) {
      await db.exec(sql)
    },
  }
}
