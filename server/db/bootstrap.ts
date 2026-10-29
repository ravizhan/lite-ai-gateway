import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Db } from './types.ts'

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql')

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
