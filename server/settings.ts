import { z } from 'zod'
import { DEFAULT_GATEWAY_SETTINGS, type GatewaySettings } from '../shared/api.ts'
import type { Db } from './db/types.ts'

/** Single row used for all gateway configuration in the existing settings table. */
const GATEWAY_SETTINGS_KEY = 'gateway'

const MAX_TTL_SECONDS = 31_536_000
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
const BODY_PATH_PATTERN = /^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*$/
const RESERVED_BODY_SEGMENTS: Record<string, true> = {
  ['__proto__']: true as const,
  prototype: true as const,
  constructor: true as const,
}

const headerSourceSchema = z.object({
  type: z.literal('header'),
  key: z.string().min(1).max(256).regex(HEADER_NAME_PATTERN, 'invalid header name'),
}).strict()

const bodySourceSchema = z.object({
  type: z.literal('body'),
  key: z.string().min(1).max(256).regex(BODY_PATH_PATTERN, 'invalid body path'),
}).strict()

const derivedSourceSchema = z.object({
  type: z.literal('derived'),
  key: z.literal(''),
}).strict()

const affinityKeySourceSchema = z.discriminatedUnion('type', [
  headerSourceSchema,
  bodySourceSchema,
  derivedSourceSchema,
])

const affinityRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    enabled: z.boolean(),
    modelPattern: z.string().max(4096),
    pathPattern: z.string().max(4096),
    userAgent: z.string().max(512),
    valuePattern: z.string().max(4096),
    ttlSeconds: z.number().int().min(0).max(MAX_TTL_SECONDS),
    keySources: z.array(affinityKeySourceSchema).max(128),
  })
  .strict()

const affinitySettingsSchema = z
  .object({
    enabled: z.boolean(),
    ttlSeconds: z.number().int().min(0).max(MAX_TTL_SECONDS),
    rules: z.array(affinityRuleSchema).max(256),
  })
  .strict()
  .superRefine((settings, ctx) => {
    const names = Object.create(null) as Record<string, true>
    settings.rules.forEach((rule, index) => {
      if (names[rule.name]) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules', index, 'name'],
          message: 'rule names must be unique',
        })
      }
      names[rule.name] = true

      for (const field of ['modelPattern', 'pathPattern', 'valuePattern'] as const) {
        if (rule[field] === '') continue
        try {
          // Compile at validation time so malformed patterns cannot reach request handling.
          new RegExp(rule[field])
        } catch {
          ctx.addIssue({
            code: 'custom',
            path: ['rules', index, field],
            message: 'invalid regular expression',
          })
        }
      }

      for (const [sourceIndex, source] of rule.keySources.entries()) {
        if (source.type !== 'body') continue
        const segments = source.key.split('.')
        if (segments.some((segment) => RESERVED_BODY_SEGMENTS[segment] === true)) {
          ctx.addIssue({
            code: 'custom',
            path: ['rules', index, 'keySources', sourceIndex, 'key'],
            message: 'body path contains a reserved segment',
          })
        }
      }
    })
  })

export const gatewaySettingsSchema = z
  .object({ affinity: affinitySettingsSchema })
  .strict()

/** 默认设置只读共享（写入方是唯一校验点）：调用方只读，禁止修改。 */
const DEFAULT_SETTINGS: GatewaySettings = deepFreeze(DEFAULT_GATEWAY_SETTINGS)

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Load persisted settings; an absent row intentionally resolves to the legacy defaults.
 * 唯一的写入路径（saveGatewaySettings）已用完整 schema 校验，故读取只做 JSON.parse，
 * 避免每个 LLM 请求都跑一遍 schema（含正则编译）。
 */
export async function loadGatewaySettings(db: Db): Promise<GatewaySettings> {
  const row = await db.get<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    GATEWAY_SETTINGS_KEY,
  )
  if (!row) return DEFAULT_SETTINGS

  try {
    return JSON.parse(row.value) as GatewaySettings
  } catch {
    throw new Error('invalid persisted gateway settings')
  }
}

/**
 * Persist the complete settings document and invalidate every existing sticky binding.
 * Clearing the binding table prevents a changed rule/TTL from reusing an old winner.
 * 调用方（admin PUT）已用 gatewaySettingsSchema 校验，此处不再重复校验。
 */
export async function saveGatewaySettings(db: Db, settings: GatewaySettings): Promise<GatewaySettings> {
  await db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    GATEWAY_SETTINGS_KEY,
    JSON.stringify(settings),
  )
  await db.run('DELETE FROM llm_session_affinity')
  return settings
}

