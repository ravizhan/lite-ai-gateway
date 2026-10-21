/**
 * 网关 API key 生成：`sk-` 前缀 + 48 位 base62 随机。
 * crypto.getRandomValues 在 Node 与 Workers 均可用。
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(48))
  let key = 'sk-'
  for (let i = 0; i < bytes.length; i++) {
    // 模偏差可接受（单用户自部署，48 位已远超暴力破解范围）
    key += ALPHABET[bytes[i] % ALPHABET.length]
  }
  return key
}
