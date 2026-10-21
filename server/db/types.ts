/** SQL 绑定参数类型：node:sqlite 与 D1 的并集（bigint/boolean 不使用，布尔用 0/1） */
export type SqlValue = string | number | null | Uint8Array

/**
 * 统一的 promise 化数据库接口，对齐 D1 形态。
 * Node 端 node:sqlite 适配器与 Workers 端 D1 适配器实现同一接口。
 */
export interface Db {
  run(sql: string, ...params: SqlValue[]): Promise<{ changes: number }>
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T | undefined>
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T[]>
  /** 多语句执行，迁移用 */
  exec(sql: string): Promise<void>
}
