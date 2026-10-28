import type { Db } from '../db/types.ts'
import { sanitizeError } from '../lib/sanitize.ts'

/** 日志来源：'call' = 客户端协议请求（含通知）；'upstream' = hub 聚合时的内部上游调用 */
export type McpLogDirection = 'call' | 'upstream'

export interface McpLogEntry {
  direction?: McpLogDirection
  group_name?: string | null
  server_name?: string | null
  method: string
  tool_name?: string | null
  duration_ms: number
  ok: 0 | 1 | boolean
  error?: string | null
  /**
   * 入站 JSON-RPC 消息原文（客户端请求 / 通知；协议层之前被拒的请求为原始 HTTP 请求体）。
   * 内部上游调用不可观测线上请求体时写合成请求。
   */
  request_body?: string | null
  /** 发给客户端的完整 JSON-RPC 响应原文（成功与失败均记录；未截断、未脱敏）；无响应时为 null */
  response_body?: string | null
}

/**
 * 写一条 mcp_logs（单条 INSERT，D1 子请求预算内）。
 * - error 必过 sanitizeError 掩码；request_body / response_body 按原文落库（截断会毁掉协议原文）。
 * - 落库失败只记 console.error，绝不把异常抛回协议路径（日志失败不能变成客户端可见的 500）。
 */
export async function logMcp(db: Db, entry: McpLogEntry): Promise<void> {
  try {
    await db.run(
      `INSERT INTO mcp_logs (
         direction, group_name, server_name, method, tool_name, duration_ms, ok, error, request_body, response_body
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.direction ?? 'call',
      entry.group_name ?? null,
      entry.server_name ?? null,
      entry.method,
      entry.tool_name ?? null,
      entry.duration_ms,
      entry.ok ? 1 : 0,
      entry.error ? sanitizeError(entry.error) : null,
      entry.request_body ?? null,
      entry.response_body ?? null,
    )
  } catch (error) {
    console.error('[mcp-log] insert failed:', sanitizeError(String((error as Error)?.message ?? error)))
  }
}
