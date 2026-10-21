import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import type { McpCapabilityKind, McpServerRow, McpTestResult } from '../../shared/api.ts'
import { sanitizeError } from '../lib/sanitize.ts'
import { discoveryTimeout } from '../lib/timeout.ts'
import { VERSION } from '../lib/version.ts'
import { getNodeMcpBindings } from './node-bindings.ts'

// 模块级缓存（单 isolate/进程内有效）：client 按 server.id 惰性建连；工具列表 TTL 60s
const clientCache = new Map<number, Promise<Client>>()
const toolsCache = new Map<number, { tools: unknown[]; fetchedAt: number }>()
const TOOLS_TTL_MS = 60_000
/** 单 kind 发现上限（防上游分页游标死循环） */
const MAX_CAPABILITIES_PER_KIND = 10_000

/**
 * 解析“是否 Node 运行时”：hub 传 boolean；管理端不传
 * （不传时按运行环境推断，Workers 上无 process）。
 */
function resolveIsNode(flag: boolean | undefined): boolean {
  if (typeof flag === 'boolean') return flag
  return typeof process !== 'undefined' && Boolean(process.versions?.node)
}

/** 按 type 建 transport；stdio/sse 仅 Node（实现由 Node 入口注入，避免进入 Workers bundle） */
async function createTransport(server: McpServerRow, isNode: boolean): Promise<Transport> {
  if (server.type === 'stdio' || server.type === 'sse') {
    if (!isNode) throw new Error(`runtime unsupported: ${server.type} upstream is node-only`)
    if (server.type === 'stdio') {
      // 依赖 node:child_process：实现由 Node 入口注入，Workers 打包时不含
      return getNodeMcpBindings().createStdioTransport({
        command: server.command!,
        args: server.args ? (JSON.parse(server.args) as string[]) : [],
        env: server.env ? (JSON.parse(server.env) as Record<string, string>) : {},
      })
    }
    // 依赖 eventsource：实现由 Node 入口注入，Workers 打包时不含
    return getNodeMcpBindings().createSseTransport(
      new URL(server.url!),
      server.headers ? (JSON.parse(server.headers) as Record<string, string>) : {},
    )
  }
  // streamable-http：fetch 实现，Node/Workers 通用，可静态 import
  return new StreamableHTTPClientTransport(new URL(server.url!), {
    requestInit: { headers: server.headers ? (JSON.parse(server.headers) as Record<string, string>) : {} },
  })
}

/** Workers 兼容校验器：默认 AjvJsonSchemaValidator 经 ajv 用 new Function 编译 schema，Workers 禁 codegen → 502 */
const jsonSchemaValidator = new CfWorkerJsonSchemaValidator()

/** 新建 client 并 connect；失败时关闭并抛错（不写入缓存） */
async function createClient(server: McpServerRow, isNode: boolean): Promise<Client> {
  const transport = await createTransport(server, isNode)
  const client = new Client({ name: 'lite-ai-gateway', version: VERSION }, { jsonSchemaValidator })
  try {
    await client.connect(transport)
  } catch (error) {
    await client.close().catch(() => {})
    throw error
  }
  return client
}

/** 取（或建）server 的上游 client，按 server.id 缓存；连接失败清缓存并抛错 */
export function getUpstreamClient(server: McpServerRow, isNode?: boolean): Promise<Client> {
  const node = resolveIsNode(isNode)
  let pending = clientCache.get(server.id)
  if (!pending) {
    pending = createClient(server, node).catch((error) => {
      clientCache.delete(server.id)
      throw error
    })
    clientCache.set(server.id, pending)
  }
  return pending
}

/**
 * 工具列表缓存读取（TTL 60s），hub 聚合 tools/list 与解析 tools/call 时用。
 * 走 listAllPages 全量分页（与能力发现同一实现）：只读第一页会让第二页之后的工具
 * 既无法解析，也不参与去重命名——管理端分组可选择它们，命名范围必须与之一致。
 */
export async function listToolsCached(server: McpServerRow, client: Client): Promise<unknown[]> {
  const cached = toolsCache.get(server.id)
  if (cached && Date.now() - cached.fetchedAt < TOOLS_TTL_MS) return cached.tools
  const tools = await listAllPages(client, 'tool')
  toolsCache.set(server.id, { tools, fetchedAt: Date.now() })
  return tools
}

/** 清空上游连接/工具缓存（管理端 reload 用）：尽力关闭所有已建 client */
export function clearUpstreamCache(): void {
  for (const pending of clientCache.values()) {
    void pending.then(
      (client) => client.close().catch(() => {}),
      () => {},
    )
  }
  clientCache.clear()
  toolsCache.clear()
}

/** 连通性测试：绕过缓存新建 client，套 15s 超时（discoveryTimeout(0)），listTools 后关闭 */
export async function testServer(server: McpServerRow, isNode?: boolean): Promise<McpTestResult> {
  const node = resolveIsNode(isNode)
  let client: Client | undefined
  try {
    const transport = await createTransport(server, node)
    client = new Client({ name: 'lite-ai-gateway', version: VERSION }, { jsonSchemaValidator })
    // connect 不接受 signal：用 Promise.race + 超时拒绝模拟（超时后走 catch 清理）
    const signal = discoveryTimeout(0) // 0 → 默认 15s
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('connect timeout')))
      }),
    ])
    const result = (await client.listTools()) as { tools?: unknown[] }
    const n = Array.isArray(result.tools) ? result.tools.length : 0
    await client.close()
    client = undefined
    return { ok: true, tools: n }
  } catch (error) {
    await client?.close().catch(() => {})
    return { ok: false, tools: 0, error: sanitizeError(String((error as Error)?.message ?? error)) }
  }
}

/** 单个发现能力项：name 为 tool/prompt 名或 resource URI，detail 为完整 JSON */
export interface DiscoveredCapability {
  kind: McpCapabilityKind
  name: string
  detail: unknown
}

/** 按 cursor 分页拉全一个 list（上游不支持分页时只取第一页）；返回原始条目数组 */
async function listAllPages(client: Client, kind: McpCapabilityKind): Promise<unknown[]> {
  const items: unknown[] = []
  let cursor: string | undefined
  for (;;) {
    const params = cursor ? { cursor } : undefined
    const result =
      kind === 'tool'
        ? await client.listTools(params)
        : kind === 'prompt'
          ? await client.listPrompts(params)
          : await client.listResources(params)
    const key = kind === 'tool' ? 'tools' : kind === 'prompt' ? 'prompts' : 'resources'
    const arr = result[key]
    if (Array.isArray(arr)) items.push(...arr)
    const next = result.nextCursor
    if (!next || next === cursor || items.length >= MAX_CAPABILITIES_PER_KIND) break
    cursor = next
  }
  return items
}

/** 条目主键名：resource 用 uri，tool/prompt 用 name（结构不符 → undefined 跳过） */
function capabilityName(item: unknown, kind: McpCapabilityKind): string | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  if (kind === 'resource') {
    if ('uri' in item && typeof item.uri === 'string') return item.uri
    return undefined
  }
  if ('name' in item && typeof item.name === 'string') return item.name
  return undefined
}

/**
 * 上游能力发现：新建 client（绕过缓存，不落连接/工具缓存），connect 后并发执行
 * tools/list、prompts/list、resources/list（各自分页拉全），整体套 discoveryTimeout(0)
 * 超时（默认 15s）。MCP 协议语义：MethodNotFound（-32601）视为该能力不受支持 → 空集；
 * 其余任何失败都抛出（调用方必须阻止 DB 变更/启用）。
 */
export async function discoverCapabilities(
  server: McpServerRow,
  isNode?: boolean,
): Promise<DiscoveredCapability[]> {
  const node = resolveIsNode(isNode)
  let client: Client | undefined
  try {
    const transport = await createTransport(server, node)
    client = new Client({ name: 'lite-ai-gateway', version: VERSION }, { jsonSchemaValidator })
    // connect / list 均不接受 signal：用 Promise.race + 超时拒绝模拟（超时后走 finally 清理）
    const signal = discoveryTimeout(0)
    const timeout = new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('discovery timeout')))
    })
    return await Promise.race([
      (async () => {
        await client!.connect(transport)
        const kinds: McpCapabilityKind[] = ['tool', 'prompt', 'resource']
        const results = await Promise.allSettled(kinds.map((kind) => listAllPages(client!, kind)))
        const caps: DiscoveredCapability[] = []
        for (let i = 0; i < kinds.length; i++) {
          const r = results[i]
          if (r.status === 'rejected') {
            // 仅 MethodNotFound 视为“该能力不受支持”→ 空集；其余失败中止发现
            const code = r.reason instanceof McpError ? r.reason.code : undefined
            if (code === ErrorCode.MethodNotFound) continue
            throw r.reason
          }
          const kind = kinds[i]
          for (const item of r.value) {
            const name = capabilityName(item, kind)
            if (!name) continue
            caps.push({ kind, name, detail: item })
          }
        }
        return caps
      })(),
      timeout,
    ])
  } finally {
    await client?.close().catch(() => {})
  }
}
