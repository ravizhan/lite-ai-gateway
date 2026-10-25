/**
 * 前后端共享类型、API 路径契约与网关错误信封工具。
 * server/ 用带 .ts 后缀的相对路径 import；src/ 用相对路径或 @/ 别名 import。
 */

// ---------- DB 行类型（与 server/db/schema.sql 对齐） ----------

export interface ProviderRow {
  id: number
  name: string
  base_url: string
  api_key: string
  type: 'llm' | 'embedding'
  enabled: number
  supports_responses: number
  timeout_ms: number
  max_concurrency: number
  transform_code: string
  created_at: string
}

export interface ModelRow {
  id: number
  provider_id: number
  model: string
  alias: string
  discovered: number
  enabled: number
}

export interface PriceRow {
  model: string
  provider_id: number
  input_price: number
  output_price: number
  cache_read_price: number
}

export interface ModelRouteRow {
  model: string
  provider_id: number
  priority: number
  enabled: number
  max_concurrency: number
}

export interface ApiKeyRow {
  id: number
  name: string
  key: string
  enabled: number
  created_at: string
}

export interface LlmLogRow {
  id: number
  ts: string
  api_key_id: number | null
  protocol: 'chat' | 'responses' | string
  model: string
  provider_id: number | null
  provider_name: string | null
  stream: number
  status: number
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number
  total_tokens: number
  ttft_ms: number | null
  duration_ms: number
  tps: number | null
  cost: number
  /** 1 = 尚未定价，首次配置价格后补算；0 = 已计价或不计费。 */
  cost_pending: number
  error: string | null
  client_ip: string | null
  req_body: string | null
  resp_body: string | null
}

export type McpServerType = 'stdio' | 'sse' | 'streamable-http'

export interface McpServerRow {
  id: number
  name: string
  type: McpServerType
  command: string | null
  args: string | null
  env: string | null
  url: string | null
  headers: string | null
  enabled: number
}

export interface McpGroupRow {
  id: number
  name: string
  description: string
}

/** MCP 能力类型（与 mcp_capabilities.kind / mcp_group_capabilities.kind 对齐） */
export type McpCapabilityKind = 'tool' | 'prompt' | 'resource'

/** 能力快照行：detail 为能力完整 JSON（resource 的 name = uri） */
export interface McpCapabilitySnapshot {
  server_id: number
  kind: McpCapabilityKind
  name: string
  detail: string
}

/** 能力计数（按 kind + 合计） */
export interface McpCapabilityCounts {
  tools: number
  prompts: number
  resources: number
  total: number
}

/** 分组能力选择项（白名单） */
export interface McpGroupCapabilitySelection {
  server_id: number
  kind: McpCapabilityKind
  name: string
}

/** 分组 + 能力白名单 + 本地 web_search 开关（GET/POST/PUT /api/admin/mcp/groups 行） */
export interface McpGroupWithCapabilities extends McpGroupRow {
  capabilities: McpGroupCapabilitySelection[]
  /** mcp_group_web_search 有行 = 1（暴露内置 web_search）；0 = 不暴露 */
  web_search: 0 | 1
}

export interface McpLogRow {
  id: number
  ts: string
  direction: string
  group_name: string | null
  server_name: string | null
  method: string
  tool_name: string | null
  duration_ms: number
  ok: number
  error: string | null
  /** 入站 JSON-RPC 消息原文（请求/通知）；协议层前被拒的请求为原始 HTTP 请求体 */
  request_body: string | null
  /** 仅失败：发给客户端的完整 JSON-RPC 失败响应原文；成功为 null（绝不落输出） */
  response_body: string | null
}

// ---------- API 响应 ----------

export interface Paged<T> {
  rows: T[]
  total: number
}

export interface AdminInfo {
  runtime: 'node' | 'cloudflare'
  version: string
  db: 'sqlite' | 'd1'
}

// ---------- Gateway settings ----------

export type AffinityKeySourceType = 'header' | 'body' | 'derived'

export interface AffinityKeySource {
  type: AffinityKeySourceType
  /** Header name or dotted body path; derived sources must use an empty key. */
  key: string
}

export interface AffinityRule {
  name: string
  enabled: boolean
  modelPattern: string
  pathPattern: string
  userAgent: string
  valuePattern: string
  /** 0 inherits the global affinity TTL. */
  ttlSeconds: number
  keySources: AffinityKeySource[]
}

export interface AffinitySettings {
  enabled: boolean
  ttlSeconds: number
  rules: AffinityRule[]
}

export interface GatewaySettings {
  affinity: AffinitySettings
}

/** 未配置亲和性时的默认设置：单条 default rule，按序匹配常见会话标识 header/body 字段。 */
export const DEFAULT_AFFINITY_SETTINGS: AffinitySettings = {
  enabled: true,
  ttlSeconds: 3600,
  rules: [
    {
      name: 'default',
      enabled: true,
      modelPattern: '',
      pathPattern: '',
      userAgent: '',
      valuePattern: '',
      ttlSeconds: 0,
      keySources: [
        { type: 'header', key: 'X-Claude-Code-Session-Id' },
        { type: 'header', key: 'Session-Id' },
        { type: 'header', key: 'Session_id' },
        { type: 'header', key: 'X-Session-ID' },
        { type: 'header', key: 'X-Session-Affinity' },
        { type: 'header', key: 'X-Client-Request-Id' },
        { type: 'body', key: 'session_id' },
        { type: 'body', key: 'sessionId' },
        { type: 'body', key: 'prompt_cache_key' },
        { type: 'body', key: 'conversation.id' },
        { type: 'body', key: 'conversation' },
        { type: 'body', key: 'metadata.user_id' },
        { type: 'body', key: 'conversation_id' },
        { type: 'derived', key: '' },
      ],
    },
  ],
}

export const DEFAULT_GATEWAY_SETTINGS: GatewaySettings = {
  affinity: DEFAULT_AFFINITY_SETTINGS,
}

export interface StatsResult {
  totals: {
    requests: number
    prompt_tokens: number
    completion_tokens: number
    cached_tokens: number
    total_tokens: number
    cost: number
    avg_ttft_ms: number | null
    avg_tps: number | null
    cache_rate: number
  }
  topModels: { model: string; requests: number; cost: number; tokens: number }[]
  buckets: { ts: string; requests: number; cost: number }[]
  modelBuckets: { ts: string; model: string; requests: number; cost: number; tokens: number }[]
  tokenFlows: {
    model: string
    provider_id: number | null
    provider_name: string
    total_tokens: number
    requests: number
    cost: number
    prompt_tokens: number
    cached_tokens: number
  }[]
}

export interface DiscoverResult {
  /** 上游 /models 返回的模型 id（去重，未写库） */
  models: string[]
}

export interface ProviderModelsSyncResult {
  added: number
  removed: number
}

export interface McpTestResult {
  ok: boolean
  tools: number
  error?: string
}

/** GET /api/admin/mcp/servers 行：附能力计数 */
export interface McpServerWithCounts extends McpServerRow {
  tool_count: number
  prompt_count: number
  resource_count: number
}

/** 单 server 能力明细 + 计数（GET /api/admin/mcp/servers/:id/capabilities 与
 *  GET /api/admin/mcp/capabilities 的 servers[] 元素） */
export interface McpServerCapabilities {
  server_id: number
  server_name: string
  capabilities: McpCapabilitySnapshot[]
  counts: McpCapabilityCounts
}

/** GET /api/admin/mcp/capabilities 响应（分组选择 UI 用） */
export interface McpCapabilitiesResult {
  servers: McpServerCapabilities[]
}

/** MCP 能力 prompt 覆盖行（mcp_prompt_overrides） */
export interface McpPromptOverrideRow {
  server_id: number
  kind: McpCapabilityKind
  name: string
  prompt: string
  updated_at: string
}

/** GET /api/admin/mcp/tools 单条能力：快照 + 默认/生效 prompt（override ?? 快照 description） */
export interface McpToolPromptItem {
  kind: McpCapabilityKind
  name: string
  detail: string
  default_prompt: string
  prompt: string
  overridden: 0 | 1
}

/** 单 server 的能力 prompt 列表（GET /api/admin/mcp/tools 的 servers[] 元素） */
export interface McpServerToolPrompts {
  server_id: number
  server_name: string
  server_type: McpServerType
  enabled: number
  items: McpToolPromptItem[]
}

/** GET /api/admin/mcp/tools 响应（工具列表页用） */
export interface McpToolPromptsResult {
  servers: McpServerToolPrompts[]
}

/** LLM 网关错误信封（与上游 the platform 形态一致） */
interface GatewayError {
  error: { message: string; type: string; param: string | null; code: string | null }
}

// ---------- 工具 ----------

/** 网关错误信封工厂（server 侧用） */
export function gatewayError(status: number, message: string, type = 'invalid_request_error'): Response {
  const body: GatewayError = { error: { message, type, param: null, code: null } }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
