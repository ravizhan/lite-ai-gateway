/**
 * 内置 `web_fetch` 的统一契约：请求 schema 与固定工具定义。
 *
 * 网关进程直接用运行时全局 `fetch` 发起 GET（Node 为 undici，Workers 为 Worker fetch），
 * 不经过任何上游 MCP。命名组开启后以固定名 `web_fetch` 暴露，同名普通工具按前缀规则改名。
 */
import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

/** 内置工具固定名：命名组开启后始终以此名暴露，不参与上游改名 */
export const WEB_FETCH_TOOL_NAME = 'web_fetch'

/** 响应体读取上限（字节）：超出部分丢弃并标记 truncated，避免日志行超过 D1 单行上限 */
export const WEB_FETCH_MAX_BYTES = 1024 * 1024

/** 统一请求：url 必填；headers 原样作为请求头；cookies 拼成 Cookie 头（与 headers 里的 Cookie 合并） */
export const webFetchRequestSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }).describe('Absolute http(s) URL to fetch with GET. Redirects are followed.'),
  headers: z
    .record(z.string().min(1), z.string())
    .optional()
    .describe('Optional request headers, as a name → value object. Sent as-is.'),
  cookies: z
    .record(
      z.string().regex(/^[^\s=;,]+$/, 'cookie name must not contain whitespace, "=", ";" or ","'),
      z.string().regex(/^[^;\r\n]*$/, 'cookie value must not contain ";" or line breaks'),
    )
    .optional()
    .describe('Optional cookies, as a name → value object. Joined into one Cookie header (appended to a Cookie header given in headers).'),
})

export type WebFetchRequest = z.input<typeof webFetchRequestSchema>
export type NormalizedWebFetchRequest = z.output<typeof webFetchRequestSchema>

/** 工具结果（序列化为单个 text 块的 JSON；不发 structuredContent，避免响应体在日志里存两份） */
export interface WebFetchResult {
  /** 跟随重定向后的最终 URL */
  url: string
  status: number
  status_text: string
  /** 响应头（不含 set-cookie，见 set_cookies） */
  headers: Record<string, string>
  /** 每个 Set-Cookie 头一项 */
  set_cookies: string[]
  content_type: string | null
  /** 文本类响应（text/*、JSON、XML、JS 等，或未声明类型）按 charset 解码 */
  body?: string
  /** 非文本响应的 base64 原始字节 */
  body_base64?: string
  /** 实际返回的字节数（截断后） */
  bytes: number
  /** 响应体超过上限被截断 */
  truncated: boolean
}

/** 固定工具定义：tools/list 直接使用本对象，inputSchema 由上面的 zod schema 生成 */
export const WEB_FETCH_TOOL: Tool = {
  name: WEB_FETCH_TOOL_NAME,
  description:
    'Fetch a URL with an HTTP GET request sent directly from the gateway, with optional headers and cookies. ' +
    'Returns JSON with status, final url, response headers, set_cookies, and the body (text, or body_base64 for binary content). ' +
    `Bodies over ${WEB_FETCH_MAX_BYTES} bytes are truncated.`,
  inputSchema: (() => {
    const { properties, ...rest } = z.toJSONSchema(webFetchRequestSchema, { target: 'draft-07', io: 'input' }) as {
      properties?: Record<string, unknown>
      [key: string]: unknown
    }
    return { ...rest, type: 'object' as const, ...(properties ? { properties: properties as Record<string, object> } : {}) }
  })(),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
}
