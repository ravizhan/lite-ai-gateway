import type { Db } from '../db/types.ts'
import {
  type AffinityKeySource,
  type AffinityRule,
  type AffinitySettings,
} from '../../shared/api.ts'

/**
 * session → provider 粘性绑定（API key + protocol + exact model + session SHA-256 作用域）。
 * 仅依赖 Db/Web API（Node sqlite 与 Workers D1 共用，无 Node-only import）。
 *
 * 身份：固定顺序取首个有效显式值（headers → body），哈希输入带来源命名空间；无显式值时
 * 用带版本前缀的 JSON 派生（Chat 前缀 system/developer messages + 首条非空 user content；
 * Responses 取顶层 instructions + input 前缀 system/developer items + 首条非空 user content）。
 * 派生根对象固定为 ['affinity-v2', protocol, { prefix: [...], user: 原始选中内容 }]，
 * 保留数组顺序与解析后的对象 key 顺序，不做递归 key 排序；没有 user 内容 → null（非粘性）。
 * 所有来源统一用 v2 哈希输入（见 makeAffinityHashInput）；只保存 64 字符小写 hex。
 *
 * claim：每次 sticky 请求生成新 UUID token，单条 UPSERT ... RETURNING 原子轮换；owned 仅由
 * 返回 token 是否等于本次 UUID 判断，未过期的不同 provider 原样返回现有 winner。
 * invalidate：只按完整主键 + provider ID + binding token 删除（changes === 1 才为 true），
 * 旧请求的 retryable failure 无法删除较新请求的 token。
 */

/** 粘性身份作用域（apiKeyId 由 /v1/** 的 apiKeyMw 保证） */
export interface AffinityKey {
  apiKeyId: number
  protocol: 'chat' | 'responses'
  model: string
  sessionHash: string
  /** Effective rule TTL（秒），提取时按规则/全局设置解析得出。 */
  ttlSeconds: number
}

/** 一次绑定结果：owned=false 表示存在未过期的其他 provider winner */
export interface AffinityBinding {
  providerId: number
  bindingToken: string
  expiresAt: number
  owned: boolean
}

const GET_BINDING_SQL = `SELECT provider_id, binding_token, expires_at
FROM llm_session_affinity
WHERE api_key_id = ? AND protocol = ? AND model = ? AND session_hash = ? AND expires_at > ?`

/**
 * claim 语句：单语句 UPSERT ... RETURNING。三个 CASE 使用同一个 now，
 * 过期时刻由调用方按规则 TTL 传入；未过期的不同 provider 原样返回现有 winner。
 * 通过 Db.get 执行；无返回 row 视为 routing-state error。
 */
const CLAIM_SQL = `INSERT INTO llm_session_affinity
  (api_key_id, protocol, model, session_hash, provider_id, binding_token, expires_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(api_key_id, protocol, model, session_hash) DO UPDATE SET
  provider_id = CASE
    WHEN llm_session_affinity.expires_at <= ?
      OR llm_session_affinity.provider_id = excluded.provider_id
    THEN excluded.provider_id ELSE llm_session_affinity.provider_id END,
  binding_token = CASE
    WHEN llm_session_affinity.expires_at <= ?
      OR llm_session_affinity.provider_id = excluded.provider_id
    THEN excluded.binding_token ELSE llm_session_affinity.binding_token END,
  expires_at = CASE
    WHEN llm_session_affinity.expires_at <= ?
      OR llm_session_affinity.provider_id = excluded.provider_id
    THEN excluded.expires_at ELSE llm_session_affinity.expires_at END
RETURNING provider_id, binding_token, expires_at`

const INVALIDATE_SQL = `DELETE FROM llm_session_affinity
WHERE api_key_id = ? AND protocol = ? AND model = ? AND session_hash = ?
  AND provider_id = ? AND binding_token = ?`

/** 显式值有效性：trim 后无控制字符、UTF-8 不超过 256 bytes */
function isUsableSessionValue(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0) return false
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i)
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false
  }
  return new TextEncoder().encode(trimmed).length <= 256
}

/** body 点路径取值（如 conversation.id → body.conversation.id） */
function getByPath(body: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.')
  let cur: unknown = body
  for (const segment of segments) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[segment]
  }
  return cur
}

// 仅缓存由完整 pattern 决定的无 flags 正则，不缓存可变设置或请求身份。
const patternCache = new Map<string, RegExp>()
const MAX_CACHED_PATTERNS = 256

function matchesPattern(pattern: string, value: string): boolean {
  if (pattern === '') return true
  let regex = patternCache.get(pattern)
  if (!regex) {
    regex = new RegExp(pattern)
    if (patternCache.size >= MAX_CACHED_PATTERNS) patternCache.clear()
    patternCache.set(pattern, regex)
  }
  return regex.test(value)
}

function matchesRule(rule: AffinityRule, model: string, path: string, userAgent: string): boolean {
  if (!matchesPattern(rule.modelPattern, model)) return false
  if (!matchesPattern(rule.pathPattern, path)) return false
  return rule.userAgent === '' || userAgent.toLowerCase().includes(rule.userAgent.toLowerCase())
}

interface ExtractedSource {
  source: AffinityKeySource
  value: string
  derived: boolean
}

function extractSourceValue(
  source: AffinityKeySource,
  protocol: 'chat' | 'responses',
  headers: Headers,
  body: Record<string, unknown>,
  derivedCache: { value: string | null | undefined },
): ExtractedSource | null {
  if (source.type === 'header') {
    const value = headers.get(source.key)
    if (value === null || !isUsableSessionValue(value)) return null
    return { source, value: value.trim(), derived: false }
  }

  if (source.type === 'body') {
    const value = getByPath(body, source.key)
    if (typeof value !== 'string' || !isUsableSessionValue(value)) return null
    return { source, value: value.trim(), derived: false }
  }

  if (derivedCache.value === undefined) {
    const derived = deriveAffinityInput(protocol, body)
    derivedCache.value = derived === null ? null : JSON.stringify(derived)
  }
  if (derivedCache.value === null) return null
  return {
    source,
    value: derivedCache.value,
    derived: true,
  }
}

function makeAffinityHashInput(
  rule: AffinityRule,
  settings: AffinitySettings,
  extracted: ExtractedSource,
): string {
  const sourceName = extracted.derived
    ? 'derived'
    : `${extracted.source.type}:${extracted.source.key}`
  const ruleIdentity = JSON.stringify({
    name: rule.name,
    modelPattern: rule.modelPattern,
    pathPattern: rule.pathPattern,
    userAgent: rule.userAgent,
    valuePattern: rule.valuePattern,
    ttlSeconds: rule.ttlSeconds,
    globalTtlSeconds: settings.ttlSeconds,
  })
  return `affinity-v2\0${ruleIdentity}\0${sourceName}\0${extracted.value}`
}

/**
 * 从 ordered affinity rules 提取粘性身份。返回 null 表示该请求非粘性（不读写 affinity 表）。
 * 所有 rule 统一用 v2 hash（rule 身份 + 来源命名空间 + 值），不同 rule 选中相同值不共享
 * binding。每个 rule 内按 keySources 顺序取首个有效值，valuePattern 不匹配时继续尝试
 * 下一个 source/下一个 rule。
 */
export async function extractAffinityKey(
  apiKeyId: number,
  protocol: 'chat' | 'responses',
  model: string,
  headers: Headers,
  body: Record<string, unknown>,
  settings: AffinitySettings,
  path: string,
): Promise<AffinityKey | null> {
  if (!settings.enabled) return null

  const userAgent = headers.get('user-agent') ?? ''
  const derivedCache: { value: string | null | undefined } = { value: undefined }
  for (const rule of settings.rules) {
    if (!rule.enabled || !matchesRule(rule, model, path, userAgent)) continue
    const effectiveTtl = rule.ttlSeconds === 0 ? settings.ttlSeconds : rule.ttlSeconds

    for (const source of rule.keySources) {
      const extracted = extractSourceValue(source, protocol, headers, body, derivedCache)
      if (!extracted || !matchesPattern(rule.valuePattern, extracted.value)) continue
      const key: AffinityKey = {
        apiKeyId,
        protocol,
        model,
        sessionHash: await hashAffinityInput(
          makeAffinityHashInput(rule, settings, extracted),
        ),
        ttlSeconds: effectiveTtl,
      }
      return key
    }
  }
  return null
}

/** 非空定义：string trim 后非空 / array 长度 > 0 / plain object 至少一个 own key */
function isNonEmpty(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (value !== null && typeof value === 'object') {
    return Object.keys(value).length > 0
  }
  return false
}

/** 派生身份：无 user 内容 → null；否则返回根对象（不递归排序 key） */
function deriveAffinityInput(
  protocol: 'chat' | 'responses',
  body: Record<string, unknown>,
): unknown[] | null {
  const prefix: unknown[] = []
  let user: unknown = null

  if (protocol === 'chat') {
    const messages = body.messages
    if (Array.isArray(messages)) {
      let prefixDone = false
      for (const message of messages) {
        if (message === null || typeof message !== 'object' || Array.isArray(message)) continue
        const msg = message as Record<string, unknown>
        const role = msg.role
        if (!prefixDone && (role === 'system' || role === 'developer')) {
          prefix.push(message)
          continue
        }
        // 前缀只取开头连续的系统/开发消息；后续消息不再计入 prefix
        prefixDone = true
        if (role === 'user') {
          const content = msg.content
          if (isNonEmpty(content)) {
            user = content
            break
          }
        }
      }
    }
  } else {
    const instructions = body.instructions
    if (typeof instructions === 'string' && instructions.trim().length > 0) {
      prefix.push(instructions)
    }
    const input = body.input
    if (typeof input === 'string') {
      if (isNonEmpty(input)) user = input
    } else if (Array.isArray(input)) {
      let prefixDone = false
      for (const item of input) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
        const msg = item as Record<string, unknown>
        // EasyInputMessage 的 type 可省略；显式的其他 item 类型（如 function_call）不算 message
        const isMessage = msg.type === undefined || msg.type === 'message'
        if (isMessage && !prefixDone) {
          const role = msg.role
          if (role === 'system' || role === 'developer') {
            prefix.push(item)
            continue
          }
        }
        // 前缀只取开头连续的 system/developer items；其余 item（message 或 function_call 等）终止前缀
        prefixDone = true
        if (isMessage && msg.role === 'user') {
          const content = msg.content
          if (isNonEmpty(content)) {
            user = content
            break
          }
        }
      }
    }
  }

  if (user === null) return null
  return ['affinity-v2', protocol, { prefix, user }]
}

/** SHA-256 → 64 字符小写 hex */
async function hashAffinityInput(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 查询当前绑定（查询结果 owned=false）。固定主键精确查询 + `expires_at > ?`；
 * 无有效绑定 → null。
 */
export async function getAffinityBinding(
  db: Db,
  key: AffinityKey,
  now: number,
): Promise<AffinityBinding | null> {
  const row = await db.get<{ provider_id: number; binding_token: string; expires_at: number }>(
    GET_BINDING_SQL,
    key.apiKeyId,
    key.protocol,
    key.model,
    key.sessionHash,
    now,
  )
  if (!row) return null
  return {
    providerId: row.provider_id,
    bindingToken: row.binding_token,
    expiresAt: row.expires_at,
    owned: false,
  }
}

/**
 * 每次 sticky 请求生成新 UUID token 并单语句 UPSERT ... RETURNING 轮换绑定。
 * 三个 CASE 使用同一个 now；过期时刻 = now + 规则 TTL（默认一小时）。返回行缺失 → throw
 * （调用方按 routing-state 503 处理）。owned 仅由返回 token 是否等于本次 UUID 判断；
 * 未过期的不同 provider 原样返回现有 winner。
 */
export async function claimAffinityProvider(
  db: Db,
  key: AffinityKey,
  providerId: number,
  now: number,
): Promise<AffinityBinding> {
  const bindingToken = crypto.randomUUID()
  const ttlMs = key.ttlSeconds * 1000
  const expiresAt = now + ttlMs
  const row = await db.get<{ provider_id: number; binding_token: string; expires_at: number }>(
    CLAIM_SQL,
    key.apiKeyId,
    key.protocol,
    key.model,
    key.sessionHash,
    providerId,
    bindingToken,
    expiresAt,
    now,
    now,
    now,
  )
  if (!row) {
    throw new Error('affinity claim returned no row')
  }
  return {
    providerId: row.provider_id,
    bindingToken: row.binding_token,
    expiresAt: row.expires_at,
    owned: row.binding_token === bindingToken,
  }
}

/**
 * 按完整主键 + provider ID + binding token 精确删除（token 守卫）。changes === 1 才为 true；
 * 旧请求的 retryable failure 无法删除较新请求的 token（changes = 0）。
 */
export async function invalidateAffinityProvider(
  db: Db,
  key: AffinityKey,
  binding: AffinityBinding,
): Promise<boolean> {
  const result = await db.run(INVALIDATE_SQL, key.apiKeyId, key.protocol, key.model, key.sessionHash, binding.providerId, binding.bindingToken)
  return result.changes === 1
}
