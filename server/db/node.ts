import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Db, SqlValue } from './types.ts'

/** node:sqlite 适配器（Node 22.5+ 内置，零原生依赖） */
export function createNodeDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  return {
    async run(sql, ...params) {
      const info = db.prepare(sql).run(...params)
      return { changes: Number(info.changes) }
    },
    async get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T | undefined> {
      const row = db.prepare(sql).get(...params)
      return row as T | undefined
    },
    async all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T[]> {
      const rows = db.prepare(sql).all(...params)
      return rows as T[]
    },
    async exec(sql) {
      db.exec(sql)
    },
  }
}
