/**
 * 上游超时信号。
 * providers.timeout_ms：0 = 不限（默认）；仅非流式 relay、模型发现、MCP 测试连接生效（流式不套，避免长流被误杀）。
 */

/** 非流式请求超时：timeout_ms > 0 时与请求自身 signal 组合（任一触发即中止），= 0 时原样返回请求 signal */
export function upstreamTimeout(provider: { timeout_ms: number }, baseSignal: AbortSignal): AbortSignal {
  if (provider.timeout_ms > 0) {
    return AbortSignal.any([baseSignal, AbortSignal.timeout(provider.timeout_ms)])
  }
  return baseSignal
}

/** 模型发现 / MCP 测试连接超时：未配置（0）时回退默认 15s */
export function discoveryTimeout(timeoutMs: number): AbortSignal {
  return timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : AbortSignal.timeout(15_000)
}
