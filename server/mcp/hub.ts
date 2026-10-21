import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  type CallToolRequest,
  ErrorCode,
  GetPromptRequestSchema,
  type GetPromptRequest,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type ReadResourceRequest,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js'
import type { McpServerRow } from '../../shared/api.ts'
import { assignExposedToolNames, type ExposedNameEntry } from '../../shared/mcp-naming.ts'
import type { Db } from '../db/types.ts'
import { sanitizeError } from '../lib/sanitize.ts'
import { VERSION } from '../lib/version.ts'
import { logMcp } from './logs.ts'
import type { McpRouteInfo } from './transport-log.ts'
import { getUpstreamClient, listToolsCached } from './upstream.ts'

interface HubOptions {
  db: Db
  servers: McpServerRow[]
  groupName: string | null
  isNode: boolean
  /**
   * 分组能力白名单：`${serverId}:${kind}:${name}` 集合（kind ∈ tool/prompt/resource）。
   * null = 不过滤（default 组，暴露全部 enabled servers 的能力）。
   */
  selection?: Set<string> | null
  /** 精确路由结果回调（日志用）：tools/call、prompts/get、resources/read 解析出上游后调用一次 */
  onRoute?: (info: McpRouteInfo) => void
}

/** 提示词前缀：${serverName}__${name}（双下划线）；工具名见 shared/mcp-naming.ts 的组内去重规则 */
function prefixed(serverName: string, name: string): string {
  return `${serverName}__${name}`
}

/** 组路由时按白名单过滤；selection 为 null（default 组）则全部放行 */
function isSelected(
  opts: HubOptions,
  server: McpServerRow,
  kind: 'tool' | 'prompt' | 'resource',
  name: string,
): boolean {
  if (opts.selection === null || opts.selection === undefined) return true
  return opts.selection.has(`${server.id}:${kind}:${name}`)
}

/** 按首个 __ 切分前缀并找上游 server；找不到 → 客户端参数错误 */
function routeByName(
  enabled: McpServerRow[],
  fullName: string,
  kind: string,
): { server: McpServerRow; name: string } {
  const idx = fullName.indexOf('__')
  if (idx <= 0) throw new McpError(ErrorCode.InvalidParams, `unknown ${kind} ${fullName}`)
  const serverName = fullName.slice(0, idx)
  const server = enabled.find((s) => s.name === serverName)
  if (!server) throw new McpError(ErrorCode.InvalidParams, `unknown ${kind} ${fullName}`)
  return { server, name: fullName.slice(idx + 2) }
}

/** 暴露工具条目：暴露名 →（上游 server + 上游原名 + 已改名的 tool 定义） */
interface ExposedTool {
  server: McpServerRow
  /** 上游侧原始工具名（调用时原样回传上游） */
  rawName: string
  /** tool 定义，name 已替换为暴露名 */
  tool: { name: string; description?: string; [key: string]: unknown }
}

/** 组暴露工具表 + 枚举失败的 server（失败时无法判定“确实不存在该工具”） */
interface ExposedTools {
  table: Map<string, ExposedTool>
  /** 枚举失败的 server 及原因：tools/list 据此记 upstream 日志，tools/call 据此判定枚举不完整 */
  failures: { server: McpServerRow; error: unknown }[]
}

/**
 * 创建聚合 MCP Server（参照 mcphub 极简版）。
 * 把组内各上游 server 的 tools/prompts/resources 合并暴露：
 * - tools：在**组暴露范围**内去重命名（原名唯一者保持原名，重名者全部加 `${serverName}__`，
 *   详见 shared/mcp-naming.ts），按“暴露名 → 上游 server + 原名”映射路由；
 * - prompts：带 `${serverName}__` 前缀按名路由；
 * - resources：无前缀，按“第一个提供该 URI 的 server”路由。
 */
export function createHubServer(opts: HubOptions): Server {
  const { db, servers, groupName } = opts
  const enabled = servers.filter((s) => s.enabled)

  // 管理端编辑的 prompt 覆盖：key = `${serverId}:${kind}:${name}`。惰性加载一次
  // （仅 list 类请求需要；tools/call 不触发），失败按无覆盖降级——不阻断协议。
  let overridesPromise: Promise<Map<string, string>> | null = null
  function loadOverrides(): Promise<Map<string, string>> {
    overridesPromise ??= db
      .all<{ server_id: number; kind: string; name: string; prompt: string }>(
        'SELECT server_id, kind, name, prompt FROM mcp_prompt_overrides',
      )
      .then((rows) => new Map(rows.map((r) => [`${r.server_id}:${r.kind}:${r.name}`, r.prompt])))
      .catch(() => new Map())
    return overridesPromise
  }

  /**
   * 组暴露工具表（暴露名 → 路由目标）：按组白名单过滤后，对**全组**工具做去重命名
   * （规则见 shared/mcp-naming.ts）。tools/list 与 tools/call 共用同一映射，所以 tools/call
   * 不需要先前的 tools/list（直接读 listToolsCached，TTL 60s）。
   * 只有**真实失败**才算枚举不完整（调用方据此整体拒绝，避免残缺名字表改变路由）：
   * 不提供 tools 能力的 server 按空库存处理，不算失败（否则纯 prompt/resource 的 server
   * 会拖垮整组）：initialize 未宣告 tools 能力时直接不请求（SDK 会在发出请求前抛错），
   * 宣告了但 tools/list 回 MethodNotFound（-32601）同样视为空（与能力发现同一协议约定）。
   */
  async function loadExposedTools(): Promise<ExposedTools> {
    const results = await Promise.allSettled(
      enabled.map(async (s) => {
        const client = await getUpstreamClient(s, opts.isNode)
        if (!client.getServerCapabilities()?.tools) return { server: s, tools: [] }
        return { server: s, tools: await listToolsCached(s, client) }
      }),
    )
    const entries: (ExposedNameEntry & { server: McpServerRow; tool: ExposedTool['tool'] })[] = []
    const failures: ExposedTools['failures'] = []
    // 同一 server 重复上报的同名工具（协议上不应出现）只保留首个：暴露名无法重复，
    // 重复项没有可区分身份，重命名只会制造噪音
    const seen = new Set<string>()
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.status === 'rejected') {
        if ((r.reason as McpError | undefined)?.code === ErrorCode.MethodNotFound) continue
        failures.push({ server: enabled[i], error: r.reason })
        continue
      }
      for (const item of r.value.tools) {
        const rawName =
          typeof item === 'object' && item !== null && 'name' in item && typeof item.name === 'string' ? item.name : ''
        if (!rawName || !isSelected(opts, r.value.server, 'tool', rawName)) continue
        const key = `${r.value.server.id}:${rawName}`
        if (seen.has(key)) continue
        seen.add(key)
        entries.push({
          serverName: r.value.server.name,
          rawName,
          server: r.value.server,
          tool: item as ExposedTool['tool'],
        })
      }
    }
    const names = assignExposedToolNames(entries)
    const table = new Map<string, ExposedTool>()
    entries.forEach((entry, i) => {
      table.set(names[i], { server: entry.server, rawName: entry.rawName, tool: { ...entry.tool, name: names[i] } })
    })
    return { table, failures }
  }

  // resources 路由表：uri → server.name，在最近一次 resources/list 时重建
  let resourceOwners = new Map<string, string>()
  let resourceList: unknown[] = []

  async function refreshResources(): Promise<void> {
    const overrides = await loadOverrides()
    const owners = new Map<string, string>()
    const list: unknown[] = []
    const startedAt = Date.now()
    const results = await Promise.allSettled(
      enabled.map(async (s) => {
        const client = await getUpstreamClient(s, opts.isNode)
        const result = (await client.listResources()) as { resources?: { uri: string; description?: string }[] }
        return { server: s, resources: result.resources ?? [] }
      }),
    )
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.status === 'rejected') {
        // 无该能力的 server 跳过（MethodNotFound），其余失败记日志
        if ((r.reason as McpError | undefined)?.code === ErrorCode.MethodNotFound) continue
        await logUpstreamFailure(enabled[i].name, 'resources/list', r.reason, startedAt)
        continue
      }
      for (const res of r.value.resources) {
        if (!isSelected(opts, r.value.server, 'resource', res.uri)) continue
        if (!owners.has(res.uri)) owners.set(res.uri, r.value.server.name)
        const custom = overrides.get(`${r.value.server.id}:resource:${res.uri}`)
        list.push(custom !== undefined ? { ...res, description: custom } : res)
      }
    }
    resourceOwners = owners
    resourceList = list
  }

  /**
   * 兜底包装：意外错误（非 McpError）统一过 sanitizeError 后以 McpError 抛给客户端；
   * 已抛出的 McpError（客户端路由错误等）原样透传。
   * 日志不在此处写：抛出的错误会被协议层转成 JSON-RPC 错误响应，
   * 由 transport 边界的观察者连同客户端原始请求一起记录（避免同一请求两条行）。
   */
  function guard<Req, Res, Extra>(fn: (request: Req, extra: Extra) => Promise<Res>): (request: Req, extra: Extra) => Promise<Res> {
    return async (request, extra) => {
      try {
        return await fn(request, extra)
      } catch (error) {
        if (error instanceof McpError) throw error
        const message = sanitizeError(String((error as Error)?.message ?? error))
        throw new McpError(ErrorCode.InternalError, message)
      }
    }
  }

  /**
   * 上游内部调用失败的留痕（direction='upstream'）。这类失败不会成为顶层 JSON-RPC 错误
   * （聚合时只跳过该 server），协议边界观察者看不到，只能在此记录。
   * - request_body：合成请求（`{jsonrpc,method}`）——上游 client 的请求 id 由 SDK 自持，
   *   线上原文不可得，不能伪造 id/params；method 为真实的上游方法名。
   * - response_body：上游结构化错误对象（code/message/data 原样取自 McpError）；
   *   网络/超时等没有上游响应体时为 null（不伪造）。
   */
  async function logUpstreamFailure(
    serverName: string | null,
    method: string,
    error: unknown,
    startedAt: number,
  ): Promise<void> {
    const code = (error as McpError | undefined)?.code
    const message = String((error as Error)?.message ?? error)
    const data = (error as McpError | undefined)?.data
    await logMcp(db, {
      direction: 'upstream',
      group_name: groupName,
      server_name: serverName,
      method,
      duration_ms: Date.now() - startedAt,
      ok: 0,
      error: message,
      request_body: JSON.stringify({ jsonrpc: '2.0', method }),
      response_body:
        typeof code === 'number'
          ? JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message, ...(data === undefined ? {} : { data }) } })
          : null,
    })
  }

  const server = new Server(
    { name: 'lite-ai-gateway', version: VERSION },
    { capabilities: { tools: {}, prompts: {}, resources: {} } },
  )

  // tools/list：并发聚合，工具名在组暴露范围内去重（唯一原名保持原名，重名者全部加
  // `${serverName}__`）。命名依赖**完整**的组范围：任一 server 的 tools/list 失败即整体失败
  // （先记一条 upstream 行），绝不返回缺了部分 server 的名字表——那会让别的 server 的同名工具
  // 顶替该暴露名，客户端旧名静默改路由。
  server.setRequestHandler(
    ListToolsRequestSchema,
    guard(async () => {
      const overrides = await loadOverrides()
      const startedAt = Date.now()
      const { table, failures } = await loadExposedTools()
      for (const failure of failures) await logUpstreamFailure(failure.server.name, 'tools/list', failure.error, startedAt)
      if (failures.length > 0) {
        throw new McpError(
          ErrorCode.InternalError,
          `tool list unavailable for ${failures.map((f) => f.server.name).join(', ')}`,
        )
      }
      return {
        tools: [...table.values()].map(({ server, rawName, tool }) => ({
          ...tool,
          description: `[${server.name}] ${overrides.get(`${server.id}:tool:${rawName}`) ?? tool.description ?? ''}`,
        })),
      }
    }),
  )

  // tools/call：暴露名 →（上游 server + 原名）由组暴露表解析，不依赖先前的 tools/list；
  // 未在组白名单内与未知工具同错，不泄露是否存在。组范围不完整（任一上游 tools/list 失败）
  // 时拒绝解析——残缺的名字表可能把该暴露名指向另一个 server 的同名工具。日志由 transport 边界统一记录
  // （onRoute 回填精确 server/tool，失败含 isError 与 JSON-RPC 错误）；
  // 上游结果原样返回（isError 透传），错误过 sanitizeError
  server.setRequestHandler(
    CallToolRequestSchema,
    guard(async (request: CallToolRequest, extra: { requestId: RequestId }) => {
      const fullName = request.params?.name ?? ''
      const startedAt = Date.now()
      const { table, failures } = await loadExposedTools()
      // 解析用的上游 tools/list 失败同样留痕（否则这条客户端请求只能看到“无法解析”）
      for (const failure of failures) await logUpstreamFailure(failure.server.name, 'tools/list', failure.error, startedAt)
      if (failures.length > 0) {
        opts.onRoute?.({ id: extra.requestId, server_name: null })
        throw new McpError(
          ErrorCode.InternalError,
          `cannot resolve tool ${fullName}: tool list unavailable for ${failures.map((f) => f.server.name).join(', ')}`,
        )
      }
      const entry = table.get(fullName)
      if (!entry) {
        opts.onRoute?.({ id: extra.requestId, server_name: null })
        throw new McpError(ErrorCode.InvalidParams, `unknown tool ${fullName}`)
      }
      const { server: upstream, rawName: toolName } = entry
      opts.onRoute?.({ id: extra.requestId, server_name: upstream.name, tool_name: toolName })
      try {
        const client = await getUpstreamClient(upstream, opts.isNode)
        return await client.callTool({ name: toolName, arguments: request.params?.arguments })
      } catch (error) {
        const message = sanitizeError(String((error as Error)?.message ?? error))
        throw error instanceof McpError ? error : new McpError(ErrorCode.InternalError, message)
      }
    }),
  )

  // prompts/list：同 tools/list 合并，前缀 ${server}__${prompt}
  server.setRequestHandler(
    ListPromptsRequestSchema,
    guard(async () => {
      const overrides = await loadOverrides()
      const startedAt = Date.now()
      const results = await Promise.allSettled(
        enabled.map(async (s) => {
          const client = await getUpstreamClient(s, opts.isNode)
          const result = (await client.listPrompts()) as { prompts?: { name: string; description?: string }[] }
          return (result.prompts ?? [])
            .filter((p) => isSelected(opts, s, 'prompt', p.name))
            .map((p) => {
              const custom = overrides.get(`${s.id}:prompt:${p.name}`)
              return { ...p, name: prefixed(s.name, p.name), ...(custom !== undefined ? { description: custom } : {}) }
            })
        }),
      )
      const prompts: unknown[] = []
      for (let i = 0; i < results.length; i++) {
        const r = results[i]
        if (r.status === 'fulfilled') {
          prompts.push(...r.value)
        } else if ((r.reason as McpError | undefined)?.code !== ErrorCode.MethodNotFound) {
          await logUpstreamFailure(enabled[i].name, 'prompts/list', r.reason, startedAt)
        }
      }
      return { prompts }
    }),
  )

  // prompts/get：按 __ 切分路由
  server.setRequestHandler(
    GetPromptRequestSchema,
    guard(async (request: GetPromptRequest, extra: { requestId: RequestId }) => {
      const fullName = request.params?.name ?? ''
      let upstream: McpServerRow
      let promptName: string
      try {
        ;({ server: upstream, name: promptName } = routeByName(enabled, fullName, 'prompt'))
      } catch (error) {
        opts.onRoute?.({ id: extra.requestId, server_name: null })
        throw error
      }
      if (!isSelected(opts, upstream, 'prompt', promptName)) {
        opts.onRoute?.({ id: extra.requestId, server_name: null })
        throw new McpError(ErrorCode.InvalidParams, `unknown prompt ${fullName}`)
      }
      opts.onRoute?.({ id: extra.requestId, server_name: upstream.name, tool_name: promptName })
      const client = await getUpstreamClient(upstream, opts.isNode)
      return client.getPrompt({ name: promptName, arguments: request.params?.arguments })
    }),
  )

  // resources/list：合并（URI 不带前缀），同时重建 uri → server 路由表
  server.setRequestHandler(
    ListResourcesRequestSchema,
    guard(async () => {
      await refreshResources()
      return { resources: resourceList }
    }),
  )

  // resources/read：按路由表找“第一个提供该 URI 的 server”；表为空则先拉一次
  server.setRequestHandler(
    ReadResourceRequestSchema,
    guard(async (request: ReadResourceRequest, extra: { requestId: RequestId }) => {
      const uri = request.params?.uri ?? ''
      if (resourceOwners.size === 0) await refreshResources()
      const owner = resourceOwners.get(uri)
      if (!owner) {
        opts.onRoute?.({ id: extra.requestId, server_name: null })
        throw new McpError(ErrorCode.InvalidParams, `unknown resource ${uri}`)
      }
      const upstream = enabled.find((s) => s.name === owner)
      if (!upstream || !isSelected(opts, upstream, 'resource', uri)) {
        opts.onRoute?.({ id: extra.requestId, server_name: null })
        throw new McpError(ErrorCode.InvalidParams, `unknown resource ${uri}`)
      }
      opts.onRoute?.({ id: extra.requestId, server_name: upstream.name })
      const client = await getUpstreamClient(upstream, opts.isNode)
      return client.readResource({ uri })
    }),
  )

  return server
}
