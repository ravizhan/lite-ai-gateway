/**
 * 错误日志脱敏：掩码敏感信息（Authorization / X-Api-Key 头值、URL query 中的 key/token）并截断。
 * 所有写入 llm_logs.error / mcp_logs.error 与 admin 错误响应摘要的文本必须先经过此函数。
 */

const MAX_LEN = 500

// 请求头值（含可选 Bearer 前缀），替换为 `xxx: ***`
const HEADER_RE = /(authorization|x-api-key):\s*(?:bearer\s+)?\S+/gi
// URL query 参数值：key / api_key / token / access_token
const QUERY_RE = /(\?|&)(key|api_key|token|access_token)=([^&\s]+)/gi

export function sanitizeError(text: string): string {
  // 先掩码再截断：避免长文本在截断处泄露半截密钥
  return String(text ?? '')
    .replace(HEADER_RE, '$1: ***')
    .replace(QUERY_RE, '$1$2=***')
    .slice(0, MAX_LEN)
}
