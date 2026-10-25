/**
 * 内置 `web_search` 的执行与预览。
 *
 * - `isWebSearchVisible`：命名组是否开启本地工具（无组/未知组 → false）。
 * - `previewSearchTransform`：只跑某一方向的转换与校验，不读库、不连上游。
 * - `runWebSearch`：从启用的绑定里等概率选一家，执行一次 `tools/call`，用绑定行里的
 *   两段 QuickJS 代码适配请求/响应，最后由宿主校验并裁剪到 max_results。
 *
 * 单次随机、不重试、不故障切换：参数非法抛 McpError；其余执行失败都以
 * `isError: true` 的工具结果返回（文本经 sanitizeError）。
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CallToolResultSchema, ContentBlockSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { McpServerRow } from '../../shared/api.ts'
import {
  webSearchRequestSchema,
  webSearchResponseSchema,
  type McpSearchPreviewRequest,
  type McpSearchPreviewResult,
  type NormalizedWebSearchRequest,
  type WebSearchResponse,
} from '../../shared/mcp-search.ts'
import type { Db } from '../db/types.ts'
import { sanitizeError } from '../lib/sanitize.ts'
import { upstreamTimeout } from '../lib/timeout.ts'
import { evalTransform } from '../lib/transform.ts'
import { getUpstreamClient } from './upstream.ts'

/** 整体网络截止（含建连与一次 tools/call），与调用方 signal 组合 */
const SEARCH_TIMEOUT_MS = 60_000

const REQUEST_FAILED = 'web_search request transform failed: '
const RESPONSE_FAILED = 'web_search response transform failed: '
const UPSTREAM_FAILED = 'web_search upstream call failed: '

/**
 * 上游原始结果结构：复用 SDK 的 CallToolResultSchema，但把 content 改成**不带 default**
 * 的可选数组，并要求原始返回里 content 或 structuredContent 至少显式存在一个。
 * SDK 默认会把缺失的 content 补成 []，补值后就无法区分“上游没给结果”和“空结果”。
 */
const SearchToolResultSchema = CallToolResultSchema.extend({
  content: z.array(ContentBlockSchema).optional(),
}).refine((value) => value.content !== undefined || value.structuredContent !== undefined, {
  message: 'MCP tool result has neither content nor structuredContent',
})

type SearchToolResult = z.output<typeof SearchToolResultSchema>

interface RunWebSearchOptions {
  db: Db
  isNode: boolean
  args: unknown
  signal: AbortSignal
  onSelected: (serverName: string) => void
}

/** 绑定行（JOIN 服务器展示名/类型，供选择与日志用） */
interface SearchBindingRow {
  id: number
  server_id: number
  tool_name: string
  request_code: string
  response_code: string
  server_name: string
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

/** 原始 isError 结果的可见文本：只取 text 块（没有则为空串） */
function upstreamErrorDetail(content: ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** 已校验并补默认值的统一请求；非法输入由调用方决定错误形态 */
function normalizeRequest(input: unknown): NormalizedWebSearchRequest {
  const parsed = webSearchRequestSchema.safeParse(input)
  if (!parsed.success) throw new Error('invalid web_search request: ' + describeIssues(parsed.error))
  return parsed.data
}

/** 解析原始 MCP 结果；校验后才补 content=[]，供转换脚本读取 */
function normalizeToolResult(payload: unknown): SearchToolResult & { content: ContentBlock[] } {
  const parsed = SearchToolResultSchema.safeParse(payload)
  if (!parsed.success) throw new Error('invalid MCP tool result: ' + describeIssues(parsed.error))
  return { ...parsed.data, content: parsed.data.content ?? [] }
}

/** 请求方向：必须得到非 null、非数组的 JSON object（即上游 tools/call 的 arguments） */
async function transformRequest(code: string, request: NormalizedWebSearchRequest): Promise<Record<string, unknown>> {
  const output = await evalTransform(code, { request })
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('request transform must return a JSON object')
  }
  return output as Record<string, unknown>
}

/** 响应方向：转换结果必须整体通过统一响应 schema，然后由宿主按原顺序裁剪到 max_results */
async function transformResponse(
  code: string,
  request: NormalizedWebSearchRequest,
  response: Record<string, unknown>,
): Promise<WebSearchResponse> {
  const output = await evalTransform(code, { request, response })
  const parsed = webSearchResponseSchema.safeParse(output)
  if (!parsed.success) throw new Error('response transform output is invalid: ' + describeIssues(parsed.error))
  return { results: parsed.data.results.slice(0, request.max_results) }
}

/** 命名组是否开启本地 web_search；不存在/未开启 → false，DB 故障照常抛出 */
export async function isWebSearchVisible(db: Db, groupName: string | null): Promise<boolean> {
  if (groupName === null) return false
  const row = await db.get<{ present: number }>(
    `SELECT 1 AS present
       FROM mcp_groups g
       JOIN mcp_group_web_search w ON w.group_id = g.id
      WHERE g.name = ?
      LIMIT 1`,
    groupName,
  )
  return row !== undefined
}

/**
 * 转换预览：不读库、不连上游、不写日志。
 * 失败抛出普通 Error（管理 API 统一映射为 HTTP 400）。
 */
export async function previewSearchTransform(input: McpSearchPreviewRequest): Promise<McpSearchPreviewResult> {
  const request = normalizeRequest(input.request)
  if (input.stage === 'request') {
    return { output: await transformRequest(input.code, request) }
  }
  const response = normalizeToolResult(input.response)
  if (response.isError === true) {
    const detail = upstreamErrorDetail(response.content)
    throw new Error('upstream returned isError=true' + (detail === '' ? '' : ': ' + detail))
  }
  return { output: await transformResponse(input.code, request, response) }
}

/** 中止原因分类：调用方取消优先于本模块的 deadline */
function abortError(deadline: AbortSignal, base: AbortSignal): Error {
  return new Error(deadline.aborted && !base.aborted ? 'web_search timed out' : 'web_search cancelled')
}

function assertActive(deadline: AbortSignal, base: AbortSignal): void {
  if (deadline.aborted) throw abortError(deadline, base)
}

/**
 * 只终止当前等待：共享 client 的 Promise 仍可完成并被其他请求复用，
 * 不关闭、不清空缓存。
 */
function abortable<T>(promise: Promise<T>, deadline: AbortSignal, base: AbortSignal): Promise<T> {
  if (deadline.aborted) return Promise.reject(abortError(deadline, base))
  // tsconfig.server.json 的 lib 为 ES2022，没有 Promise.withResolvers
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(deadline, base))
    deadline.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        deadline.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        deadline.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** 等 Promise 时套 deadline，并把失败统一成带前缀的上游错误（超时/取消单独分类） */
async function awaitWithDeadline<T>(promise: Promise<T>, deadline: AbortSignal, base: AbortSignal): Promise<T> {
  try {
    return await abortable(promise, deadline, base)
  } catch (error) {
    if (deadline.aborted) throw abortError(deadline, base)
    // SDK 自己的计时器与 deadline 同预算（RequestTimeout），同样不换一家、不重试
    if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
      throw new Error('web_search timed out', { cause: error })
    }
    throw new Error(UPSTREAM_FAILED + messageOf(error), { cause: error })
  }
}

/** 等概率选一条启用绑定；Workers 只接受 streamable-http 上游（stdio/sse 仅 Node） */
async function selectBinding(db: Db, isNode: boolean): Promise<SearchBindingRow | null> {
  const rows = await db.all<SearchBindingRow>(
    `SELECT u.id, u.server_id, u.tool_name, u.request_code, u.response_code,
            s.name AS server_name
       FROM mcp_search_upstreams u
       JOIN mcp_servers s ON s.id = u.server_id
      WHERE u.enabled = 1 AND s.enabled = 1` +
      (isNode ? '' : ` AND s.type = 'streamable-http'`) +
      ` ORDER BY u.id`,
  )
  if (rows.length === 0) return null
  return rows[Math.floor(Math.random() * rows.length)] ?? null
}

export async function runWebSearch(options: RunWebSearchOptions): Promise<CallToolResult> {
  const parsed = webSearchRequestSchema.safeParse(options.args)
  if (!parsed.success) {
    // 参数非法时不选上游、不执行脚本
    throw new McpError(ErrorCode.InvalidParams, 'invalid web_search arguments', { issues: parsed.error.issues })
  }
  return execute(
    { db: options.db, isNode: options.isNode, signal: options.signal, onSelected: options.onSelected },
    parsed.data,
  )
}

async function execute(
  options: Omit<RunWebSearchOptions, 'args'>,
  request: NormalizedWebSearchRequest,
): Promise<CallToolResult> {
  const base = options.signal
  const deadline = upstreamTimeout({ timeout_ms: SEARCH_TIMEOUT_MS }, base)
  try {
    // 已取消/已超时的请求不再选上游（避免无意义的读取与日志归属）
    assertActive(deadline, base)
    const selected = await selectBinding(options.db, options.isNode)
    if (selected === null) return toolError('web_search: no eligible upstream')
    options.onSelected(selected.server_name)

    // 绑定表只存 (server_id, tool_name)；连接缓存按 mcp_servers.id 索引，必须取真实服务器行
    const server = await options.db.get<McpServerRow>('SELECT * FROM mcp_servers WHERE id = ?', selected.server_id)
    if (!server || server.enabled !== 1) return toolError('web_search: selected upstream unavailable')

    assertActive(deadline, base)
    let mapped: Record<string, unknown>
    try {
      mapped = await transformRequest(selected.request_code, request)
    } catch (error) {
      throw new Error(REQUEST_FAILED + messageOf(error), { cause: error })
    }
    assertActive(deadline, base)

    const client: Client = await awaitWithDeadline(getUpstreamClient(server, options.isNode), deadline, base)
    assertActive(deadline, base)

    const raw: SearchToolResult = await awaitWithDeadline(
      client.request(
        { method: 'tools/call', params: { name: selected.tool_name, arguments: mapped } },
        SearchToolResultSchema,
        { signal: deadline, timeout: SEARCH_TIMEOUT_MS, resetTimeoutOnProgress: false },
      ),
      deadline,
      base,
    )

    // 上游 isError 不进入用户响应转换，也不猜测解包；只用于脱敏后的工具错误
    if (raw.isError === true) {
      const detail = upstreamErrorDetail(raw.content ?? [])
      throw new Error(UPSTREAM_FAILED + (detail === '' ? 'upstream returned isError=true' : detail))
    }
    assertActive(deadline, base)

    let output: WebSearchResponse
    try {
      output = await transformResponse(selected.response_code, request, { ...raw, content: raw.content ?? [] })
    } catch (error) {
      throw new Error(RESPONSE_FAILED + messageOf(error), { cause: error })
    }
    assertActive(deadline, base)

    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
    }
  } catch (error) {
    return toolError(sanitizeError(messageOf(error)))
  }
}
