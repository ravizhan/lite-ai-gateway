import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Db } from './types.ts'

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql')
const INCREMENTAL_VACUUM_INTERVAL_MS = 60 * 60 * 1000

/**
 * Node 启动时建表：库为空（sqlite_master 无任何用户表）→ 执行 schema.sql 创建结构；
 * 非空 → 跳过（无增量迁移，schema 变更手工处理）。返回是否执行了建表。
 * 仅 Node 入口调用（node:fs 不进入 Workers bundle）。
 */
export async function ensureSchema(db: Db): Promise<boolean> {
  const row = await db.get<{ n: number }>(
    "SELECT count(*) AS n FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'",
  )
  if (row?.n) return false
  const sql = await readFile(schemaPath, 'utf8')
  await db.exec(sql)
  return true
}

/**
 * 确保 auto_vacuum = INCREMENTAL（2）。该模式只能在建表前设置，已有库须重建一次（VACUUM）
 * 才生效：空库瞬间完成；存量库耗时与库大小成正比，期间需要约一倍库大小的临时磁盘。
 * 返回是否执行了转换。仅 Node 入口调用；D1 的存储由 Cloudflare 管理。
 */
export async function ensureIncrementalVacuum(db: Db): Promise<boolean> {
  const row = await db.get<{ auto_vacuum: number }>('PRAGMA auto_vacuum')
  if (row?.auto_vacuum === 2) return false
  await db.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM;')
  return true
}

/** 每小时把 freelist 页截出文件尾部，归还磁盘空间；freelist 为空时近乎零开销 */
export function scheduleIncrementalVacuum(db: Db): void {
  setInterval(() => {
    db.exec('PRAGMA incremental_vacuum').catch((error: unknown) => {
      console.error('[db] incremental_vacuum failed:', error)
    })
  }, INCREMENTAL_VACUUM_INTERVAL_MS).unref()
}
