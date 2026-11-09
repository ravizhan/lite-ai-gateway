import type { Db } from '../db/types.ts'
import { deriveAffinityInput, hashAffinityInput } from './session-affinity.ts'
import type { NormalizedUsage } from './usage.ts'

/**
 * 缓存率异常监控（chat/responses 成功请求）。按对话跟踪缓存率 = cached / prompt：
 * 对话身份 = API key + protocol + model + 派生对话哈希（与派生亲和身份同一输入：开头的
 * system/developer 前缀 + 首条非空 user content），同一 agent 会话里的子对话互不干扰；
 * 没有 user 内容的请求不监控。
 *
 * - 预热：对话开头缓存率逐级上升的请求不判定。满足任一条件即进入稳定期，此后每条请求都
 *   判定：上一条缓存率已达 LOW_BP；出现过缓存命中后缓存率不再上升（持平或下降）；已观测
 *   WARMUP_MAX_REQUESTS 条（防止缓慢爬升的低缓存率永远不判定）。
 * - 异常（稳定期）：低于对话峰值 DROP_BP 及以上（突降，以及突降后持续偏低），或低于
 *   LOW_BP（持续低缓存率）。对话从未出现缓存命中（峰值 0，如上游不支持缓存）时不判定。
 * - 空闲超过 IDLE_RESET_MS 视为上游缓存可能已自然过期，下一条请求重新预热。
 *
 * 状态更新与判定在同一条 UPSERT ... RETURNING 内完成（SET 右侧引用的都是旧行值）。
 */

const WARMUP_MAX_REQUESTS = 8
/** 缓存率以万分比整数存储与比较，避免浮点边界误差（95% → 9500） */
const DROP_BP = 1000
const LOW_BP = 8000
const IDLE_RESET_MS = 5 * 60 * 1000

const EXPIRED = 'expires_at <= ?'
const STEADY = `(steady = 1 OR requests >= ${WARMUP_MAX_REQUESTS} OR last_rate_bp >= ${LOW_BP}
  OR (peak_rate_bp > 0 AND excluded.last_rate_bp <= last_rate_bp))`

const WATCH_SQL = `INSERT INTO llm_cache_watch
  (api_key_id, protocol, model, conversation_hash, requests, last_rate_bp, peak_rate_bp, steady, anomaly, expires_at)
VALUES (?, ?, ?, ?, 1, ?, ?, 0, 0, ?)
ON CONFLICT(api_key_id, protocol, model, conversation_hash) DO UPDATE SET
  requests = CASE WHEN ${EXPIRED} THEN 1 ELSE requests + 1 END,
  steady = CASE WHEN ${EXPIRED} THEN 0 WHEN ${STEADY} THEN 1 ELSE 0 END,
  anomaly = CASE
    WHEN ${EXPIRED} THEN 0
    WHEN ${STEADY}
      AND max(peak_rate_bp, excluded.last_rate_bp) > 0
      AND (excluded.last_rate_bp < ${LOW_BP} OR excluded.last_rate_bp <= peak_rate_bp - ${DROP_BP})
    THEN 1 ELSE 0 END,
  peak_rate_bp = CASE WHEN ${EXPIRED} THEN excluded.last_rate_bp
    ELSE max(peak_rate_bp, excluded.last_rate_bp) END,
  last_rate_bp = excluded.last_rate_bp,
  expires_at = excluded.expires_at
RETURNING requests, anomaly`

const PURGE_SQL = `DELETE FROM llm_cache_watch WHERE expires_at <= ?`

export interface CacheWatchScope {
  apiKeyId: number
  protocol: 'chat' | 'responses'
  model: string
  body: Record<string, unknown>
}

/** 记录本次成功请求的缓存率并返回是否异常（异常请求由调用方落库请求体）。 */
export async function detectCacheAnomaly(
  db: Db,
  scope: CacheWatchScope,
  usage: NormalizedUsage,
): Promise<boolean> {
  if (usage.prompt <= 0) return false
  const derived = deriveAffinityInput(scope.protocol, scope.body)
  if (derived === null) return false

  const conversationHash = await hashAffinityInput(JSON.stringify(derived))
  const rateBp = Math.round((usage.cached * 10000) / usage.prompt)
  const now = Date.now()
  const row = await db.get<{ requests: number; anomaly: number }>(
    WATCH_SQL,
    scope.apiKeyId,
    scope.protocol,
    scope.model,
    conversationHash,
    rateBp,
    rateBp,
    now + IDLE_RESET_MS,
    now,
    now,
    now,
    now,
  )
  // 新对话（或过期重置）时顺带清理过期状态：表内只保留最近活跃的对话
  if (row?.requests === 1) await db.run(PURGE_SQL, now)
  return row?.anomaly === 1
}
