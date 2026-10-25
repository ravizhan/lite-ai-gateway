/**
 * 内置 `web_search` 的统一契约：请求/响应 schema、固定工具定义与管理 API 类型。
 *
 * server/ 在运行时使用本文件（zod 校验 + QuickJS 转换）；src/ 只 import 这里的类型，
 * 实际工具定义通过 GET /api/admin/mcp/search/presets 获取，避免把 zod 与 schema
 * 生成代码额外打进前端运行包。
 */
import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
// 仅类型导入（构建时擦除）：.js 扩展名让前端 tsc（不接受 .ts 扩展）与 ESM 类型解析一致。
import type { McpServerType } from './api.js'

/** 内置工具固定名：命名组开启搜索后始终以此名暴露，不参与上游改名 */
export const WEB_SEARCH_TOOL_NAME = 'web_search'

/** 统一请求：query 必填；max_results 为最终返回上限；objective 仅传给支持它的上游 */
export const webSearchRequestSchema = z.strictObject({
  query: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .describe('Search query text. Leading/trailing whitespace is trimmed; must not be empty.'),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe(
      'Maximum number of results returned to the client (1-20). The host truncates the converted results to this limit even if an upstream returns more.',
    ),
  objective: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .optional()
    .describe('Optional search objective. Forwarded only to upstreams whose request preset supports it.'),
})

export type WebSearchRequest = z.input<typeof webSearchRequestSchema>
export type NormalizedWebSearchRequest = z.output<typeof webSearchRequestSchema>

/** 统一响应：每条结果必须有 http(s) URL 与正文；title/published_at 缺失时省略 */
export const webSearchResponseSchema = z.strictObject({
  results: z.array(
    z.strictObject({
      url: z.url({ protocol: /^https?$/ }).describe('Source page URL (http or https).'),
      content: z.string().describe('Excerpt or summary of the source page; may be empty.'),
      title: z.string().optional().describe('Page title when the upstream provides one.'),
      published_at: z
        .string()
        .min(1)
        .optional()
        .describe('Publication date supplied by the upstream; omitted when unknown.'),
    }),
  ),
})

export type WebSearchResponse = z.output<typeof webSearchResponseSchema>

/** z.toJSONSchema 的根对象：properties 的值允许 boolean 子 schema，SDK 的 Tool 只接受对象 */
interface GeneratedObjectSchema {
  properties?: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}

/** 把 zod 生成的根 schema 收窄为 SDK Tool 的根对象形状（保留 type: 'object' 字面量） */
function toolObjectSchema(generated: GeneratedObjectSchema): Tool['inputSchema'] {
  const { properties: generatedProperties, ...rest } = generated
  const properties: Record<string, object> = {}
  for (const [key, value] of Object.entries(generatedProperties ?? {})) {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`unsupported boolean JSON schema at property: ${key}`)
    }
    properties[key] = value
  }
  return {
    ...rest,
    type: 'object',
    ...(generatedProperties ? { properties } : {}),
  }
}

/** 固定工具定义：tools/list 直接使用本对象，schema 由上面的 zod schema 生成 */
export const WEB_SEARCH_TOOL: Tool = {
  name: WEB_SEARCH_TOOL_NAME,
  description:
    'Search the web using one randomly selected configured MCP upstream. Returns source URLs and excerpts, not full-page extraction.',
  inputSchema: toolObjectSchema(z.toJSONSchema(webSearchRequestSchema, { target: 'draft-07', io: 'input' })),
  outputSchema: toolObjectSchema(z.toJSONSchema(webSearchResponseSchema, { target: 'draft-07', io: 'output' })),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
}

/** 搜索上游绑定行（mcp_search_upstreams）：身份为 (server_id, tool_name) */
export interface McpSearchUpstreamRow {
  id: number
  server_id: number
  /** 上游原始工具名（不是 hub 加前缀后的暴露名） */
  tool_name: string
  enabled: number
  request_code: string
  response_code: string
  preset_id: string | null
  preset_version: number | null
}

/** 管理列表项：附服务器展示信息与能力快照可用性，绝不附带服务器凭据 */
export interface McpSearchUpstreamItem extends McpSearchUpstreamRow {
  server_name: string
  server_type: McpServerType
  server_enabled: number
  /** 能力快照中仍存在同名 kind='tool'（仅展示用，不触发重新发现） */
  tool_available: 0 | 1
}

/** 可编辑预置：代码只是起点，应用后复制进绑定行，运行时只读绑定行代码 */
export interface McpSearchPreset {
  id: string
  version: number
  label: string
  /** 上游原始工具名 */
  tool_name: string
  /** ({ request }) => upstreamArguments */
  request_code: string
  /** ({ request, response }) => ({ results }) */
  response_code: string
  sample_request: WebSearchRequest
  sample_response: Record<string, unknown>
}

/** GET /api/admin/mcp/search/presets */
export interface McpSearchPresetsResult {
  tool: typeof WEB_SEARCH_TOOL
  presets: readonly McpSearchPreset[]
}

/** POST /api/admin/mcp/search/preview：只执行指定方向的转换与校验，不读库、不连上游 */
export type McpSearchPreviewRequest =
  | { stage: 'request'; code: string; request: WebSearchRequest }
  | { stage: 'response'; code: string; request: WebSearchRequest; response: Record<string, unknown> }

export interface McpSearchPreviewResult {
  output: Record<string, unknown> | WebSearchResponse
}
