import type { PriceRow } from '../../shared/api.ts'

/** 归一化后的 token 用量（缺省 0） */
export interface NormalizedUsage {
  prompt: number
  completion: number
  cached: number
  total: number
}

/** 取数字字段；非 number 视为缺失（由调用方 ?? 兜底） */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * Chat Completions usage 归一化。
 * cached 兼容两种形态：标准 `prompt_tokens_details.cached_tokens` 与
 * DeepSeek 变体 `prompt_cache_hit_tokens`（cached 是 prompt 的子集）。
 */
export function normalizeChatUsage(raw: unknown): NormalizedUsage {
  const r = (raw ?? {}) as Record<string, unknown>
  const details = r.prompt_tokens_details as Record<string, unknown> | undefined
  const prompt = num(r.prompt_tokens) ?? 0
  const completion = num(r.completion_tokens) ?? 0
  const cached = num(details?.cached_tokens) ?? num(r.prompt_cache_hit_tokens) ?? 0
  return {
    prompt,
    completion,
    cached,
    total: num(r.total_tokens) ?? prompt + completion,
  }
}

/** Responses API usage 归一化（input_tokens / output_tokens / input_tokens_details.cached_tokens） */
export function normalizeResponsesUsage(raw: unknown): NormalizedUsage {
  const r = (raw ?? {}) as Record<string, unknown>
  const details = r.input_tokens_details as Record<string, unknown> | undefined
  const prompt = num(r.input_tokens) ?? 0
  const completion = num(r.output_tokens) ?? 0
  const cached = num(details?.cached_tokens) ?? 0
  return {
    prompt,
    completion,
    cached,
    total: num(r.total_tokens) ?? prompt + completion,
  }
}

/** Embedding usage 归一化：prompt=total、completion=0；兼容 OpenAI usage 与 Cohere meta.billed_units。 */
export function normalizeEmbeddingUsage(raw: unknown): NormalizedUsage {
  const r = (raw ?? {}) as Record<string, unknown>
  const meta = r.meta as Record<string, unknown> | undefined
  const billedUnits = meta?.billed_units as Record<string, unknown> | undefined
  const total = num(r.total_tokens) ?? num(r.prompt_tokens) ?? num(billedUnits?.input_tokens) ?? 0
  return { prompt: total, completion: 0, cached: 0, total }
}

/**
 * 计费（美元）：(prompt − cached) × input_price + cached × cache_read_price + completion × output_price，均按 1M tokens 计价。
 * 无价格行 → 0。
 */
export function computeCost(u: NormalizedUsage, price: PriceRow | undefined): number {
  if (!price) return 0
  return (
    ((u.prompt - u.cached) * price.input_price +
      u.cached * price.cache_read_price +
      u.completion * price.output_price) /
    1e6
  )
}

/**
 * TPS：流式 = completion / max(duration − ttft, 1) × 1000；非流式 = completion / max(duration, 1) × 1000。
 * completion ≤ 0 → null（无输出 token 不计 TPS）。
 */
export function calcTps(
  completion: number,
  durationMs: number,
  ttftMs: number | null,
  stream: boolean,
): number | null {
  if (completion <= 0) return null
  const denom = stream ? Math.max(durationMs - (ttftMs ?? durationMs), 1) : Math.max(durationMs, 1)
  return (completion / denom) * 1000
}
