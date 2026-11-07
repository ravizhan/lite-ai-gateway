/**
 * 内置 `web_fetch` 的执行：网关直接发 GET，不经过上游 MCP，只允许访问公网。
 *
 * 公网限制：每一跳（含重定向目标）先静态检查 URL 主机（localhost、非公网 IP 字面量直接拒绝）；
 * Node 端再由注入的单跳实现在连接层检查 DNS 结果（见 fetch-node.ts，防 DNS 重绑定）。
 * Workers 端用 `fetch(redirect: 'manual')`，域名解析在 Cloudflare 边缘完成，
 * 出站本来就到不了网关所在内网，所以只做静态检查。
 *
 * 参数非法抛 McpError（InvalidParams）；网络错误、超时、取消、非公网目标以 `isError: true` 的
 * 工具结果返回（文本经 sanitizeError）。HTTP 非 2xx 不算工具错误，状态码原样放进结果。
 */
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  WEB_FETCH_MAX_BYTES,
  webFetchRequestSchema,
  type NormalizedWebFetchRequest,
  type WebFetchResult,
} from '../../shared/mcp-fetch.ts'
import type { Db } from '../db/types.ts'
import { checkUrlHost } from '../lib/public-address.ts'
import { sanitizeError } from '../lib/sanitize.ts'
import { upstreamTimeout } from '../lib/timeout.ts'
import { WebFetchBlockedError, getNodeMcpBindings, type WebFetchHop } from './node-bindings.ts'

/** 整体截止（建连 + 读完响应体），与调用方 signal 组合 */
const FETCH_TIMEOUT_MS = 60_000

/** 最多跟随的重定向次数（与 fetch 规范一致） */
const MAX_REDIRECTS = 20

/** 跨源重定向时去掉的凭据头（与 undici 行为一致，避免把 Cookie/Authorization 带给别的站点） */
const CROSS_ORIGIN_STRIP = ['authorization', 'cookie', 'proxy-authorization']

interface RunWebFetchOptions {
  isNode: boolean
  args: unknown
  signal: AbortSignal
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

/** 组装请求头：cookies 拼成一个 Cookie 头，追加到 headers 里已有的 Cookie（大小写不敏感）之后 */
function buildHeaders(request: NormalizedWebFetchRequest): Headers {
  const headers = new Headers(request.headers)
  const pairs = Object.entries(request.cookies ?? {}).map(([name, value]) => `${name}=${value}`)
  if (pairs.length > 0) {
    const existing = headers.get('cookie')
    headers.set('cookie', [...(existing ? [existing] : []), ...pairs].join('; '))
  }
  return headers
}

/** 文本类：text/*、JSON、XML、JS、表单、YAML/CSV 等；未声明 Content-Type 时按文本处理 */
function isTextual(contentType: string | null): boolean {
  if (contentType === null) return true
  const mime = contentType.split(';')[0].trim().toLowerCase()
  if (mime === '' || mime.startsWith('text/')) return true
  if (/[+/](json|xml)$/.test(mime)) return true
  return /^application\/(json|xml|javascript|ecmascript|x-javascript|x-www-form-urlencoded|graphql|yaml|x-yaml|toml|x-ndjson|csv)$/.test(
    mime,
  )
}

/** 按 Content-Type 的 charset 解码；未知 charset 回退 UTF-8（截断处的半个字符替换为 U+FFFD） */
function decodeText(bytes: Uint8Array, contentType: string | null): string {
  const charset = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? '')?.[1]
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(charset ?? 'utf-8')
  } catch {
    decoder = new TextDecoder('utf-8')
  }
  return decoder.decode(bytes)
}

/** base64（Workers 无 Buffer：分块拼二进制串再 btoa） */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** 读响应体到上限为止；超出即取消剩余流 */
async function readLimited(body: ReadableStream<Uint8Array> | null): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!body) return { bytes: new Uint8Array(0), truncated: false }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (size + value.byteLength > WEB_FETCH_MAX_BYTES) {
      chunks.push(value.subarray(0, WEB_FETCH_MAX_BYTES - size))
      size = WEB_FETCH_MAX_BYTES
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
    size += value.byteLength
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, truncated }
}

/** 命名组是否开启本地 web_fetch；不存在/未开启 → false，DB 故障照常抛出 */
export async function isWebFetchVisible(db: Db, groupName: string | null): Promise<boolean> {
  if (groupName === null) return false
  const row = await db.get<{ present: number }>(
    `SELECT 1 AS present
       FROM mcp_groups g
       JOIN mcp_group_web_fetch f ON f.group_id = g.id
      WHERE g.name = ?
      LIMIT 1`,
    groupName,
  )
  return row !== undefined
}

/** 静态检查一跳的目标：只允许 http(s)，主机不能是 localhost 或非公网 IP */
function assertPublicUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebFetchBlockedError(`unsupported protocol ${url.protocol}`)
  }
  if (!checkUrlHost(url.hostname).public) throw new WebFetchBlockedError(url.hostname)
}

/** 单跳：Node 走注入实现（连接层 DNS 检查），Workers 走手动重定向的全局 fetch */
async function hop(isNode: boolean, url: URL, headers: Headers, signal: AbortSignal): Promise<WebFetchHop> {
  if (isNode) return getNodeMcpBindings().webFetchHop(url, headers, signal)
  const response = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal })
  return { status: response.status, statusText: response.statusText, headers: response.headers, body: response.body }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export async function runWebFetch(options: RunWebFetchOptions): Promise<CallToolResult> {
  const parsed = webFetchRequestSchema.safeParse(options.args)
  if (!parsed.success) {
    throw new McpError(ErrorCode.InvalidParams, 'invalid web_fetch arguments', { issues: parsed.error.issues })
  }
  const request = parsed.data
  const base = options.signal
  const deadline = upstreamTimeout({ timeout_ms: FETCH_TIMEOUT_MS }, base)
  try {
    let url = new URL(request.url)
    const headers = buildHeaders(request)
    let response: WebFetchHop
    for (let redirects = 0; ; redirects++) {
      assertPublicUrl(url)
      response = await hop(options.isNode, url, headers, deadline)
      const location = response.headers.get('location')
      if (!REDIRECT_STATUSES.has(response.status) || location === null) break
      if (redirects >= MAX_REDIRECTS) throw new Error(`too many redirects (> ${MAX_REDIRECTS})`)
      await response.body?.cancel().catch(() => {})
      const next = new URL(location, url)
      if (next.origin !== url.origin) for (const name of CROSS_ORIGIN_STRIP) headers.delete(name)
      url = next
    }
    const contentType = response.headers.get('content-type')
    const { bytes, truncated } = await readLimited(response.body)
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, name) => {
      if (name !== 'set-cookie') responseHeaders[name] = value
    })
    const result: WebFetchResult = {
      url: url.href,
      status: response.status,
      status_text: response.statusText,
      headers: responseHeaders,
      set_cookies: response.headers.getSetCookie(),
      content_type: contentType,
      ...(isTextual(contentType) ? { body: decodeText(bytes, contentType) } : { body_base64: toBase64(bytes) }),
      bytes: bytes.byteLength,
      truncated,
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  } catch (error) {
    if (error instanceof WebFetchBlockedError) return toolError(sanitizeError('web_fetch ' + error.message))
    const blocked = (error as { cause?: unknown } | undefined)?.cause
    if (blocked instanceof WebFetchBlockedError) return toolError(sanitizeError('web_fetch ' + blocked.message))
    if (deadline.aborted) return toolError(base.aborted ? 'web_fetch cancelled' : 'web_fetch timed out')
    const cause = (error as { cause?: unknown } | undefined)?.cause
    const detail = String((error as Error)?.message ?? error) + (cause instanceof Error ? `: ${cause.message}` : '')
    return toolError(sanitizeError('web_fetch failed: ' + detail))
  }
}