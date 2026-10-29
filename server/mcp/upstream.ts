import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ErrorCode, McpError, type Prompt, type Resource, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import type { McpCapabilityKind, McpServerRow, McpTestResult } from '../../shared/api.ts'
import { sanitizeError } from '../lib/sanitize.ts'
import { discoveryTimeout } from '../lib/timeout.ts'
import { VERSION } from '../lib/version.ts'
import { getNodeMcpBindings } from './node-bindings.ts'

// 模块级缓存（单 isolate/进程内有效）：client 按 server.id 惰性建连；工具列表 TTL 60s
const clientCache = new Map<number, Promise<Client>>()
const toolsCache = new Map<number, { tools: Tool[]; fetchedAt: number }>()
const TOOLS_TTL_MS = 60_000
/** 单 kind 发现上限（防上游分页游标死循环） */
const MAX_CAPABILITIES_PER_KIND = 10_000

/** 按 type 建 transport；stdio/sse 仅 Node（实现由 Node 入口注入，避免进入 Workers bundle） */
function createTransport(server: Omit<McpServerRow, 'id'>, isNode: boolean): Transport {
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
async function createClient(server: Omit<McpServerRow, 'id'>, isNode: boolean): Promise<Client> {
  const transport = createTransport(server, isNode)
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
export function getUpstreamClient(server: McpServerRow, isNode: boolean): Promise<Client> {
  let pending = clientCache.get(server.id)
  if (!pending) {
    pending = createClient(server, isNode).catch((error) => {
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
export async function listToolsCached(server: McpServerRow, client: Client): Promise<Tool[]> {
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

/** 连通性测试：绕过缓存新建 client，connect 套 15s 超时（discoveryTimeout(0)），数完全部工具页后关闭 */
export async function testServer(server: McpServerRow, isNode: boolean): Promise<McpTestResult> {
  const signal = discoveryTimeout(0) // 0 → 默认 15s
  const connecting = createClient(server, isNode)
  try {
    // connect 不接受 signal：用 Promise.race + 超时拒绝模拟
    const client = await Promise.race([
      connecting,
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('connect timeout')), { once: true })
      }),
    ])
    const tools = await listAllPages(client, 'tool')
    await client.close()
    return { ok: true, tools: tools.length }
  } catch (error) {
    // 超时/失败后连接可能仍在后台建立：等到它落定即关闭，避免连接泄漏
    void connecting.then(
      (client) => client.close().catch(() => {}),
      () => {},
    )
    return { ok: false, tools: 0, error: sanitizeError(String((error as Error)?.message ?? error)) }
  }
}

/** 单个发现能力项：name 为 tool/prompt 名或 resource URI，detail 为完整 JSON */
export interface DiscoveredCapability {
  kind: McpCapabilityKind
  name: string
  detail: unknown
}

/** 按 cursor 分页拉全一个 list（上游不支持分页时只取第一页） */
async function listAllPages(client: Client, kind: 'tool'): Promise<Tool[]>
async function listAllPages(client: Client, kind: 'prompt'): Promise<Prompt[]>
async function listAllPages(client: Client, kind: 'resource'): Promise<Resource[]>
async function listAllPages(client: Client, kind: McpCapabilityKind): Promise<(Tool | Prompt | Resource)[]>
async function listAllPages(client: Client, kind: McpCapabilityKind): Promise<(Tool | Prompt | Resource)[]> {
  const items: (Tool | Prompt | Resource)[] = []
  let cursor: string | undefined
  for (;;) {
    const params = cursor ? { cursor } : undefined
    let page: { items: (Tool | Prompt | Resource)[]; nextCursor?: string }
    if (kind === 'tool') {
      const result = await client.listTools(params)
      page = { items: result.tools, nextCursor: result.nextCursor }
    } else if (kind === 'prompt') {
      const result = await client.listPrompts(params)
      page = { items: result.prompts, nextCursor: result.nextCursor }
    } else {
      const result = await client.listResources(params)
      page = { items: result.resources, nextCursor: result.nextCursor }
    }
    items.push(...page.items)
    if (!page.nextCursor || page.nextCursor === cursor || items.length >= MAX_CAPABILITIES_PER_KIND) break
    cursor = page.nextCursor
  }
  return items
}

/** 条目主键名：resource 用 uri，tool/prompt 用 name */
function capabilityName(item: Tool | Prompt | Resource, kind: McpCapabilityKind): string {
  return kind === 'resource' ? (item as Resource).uri : (item as Tool | Prompt).name
}

/**
 * 上游能力发现：新建 client（绕过缓存，不落连接/工具缓存），connect 后并发执行
 * tools/list、prompts/list、resources/list（各自分页拉全），整体套 discoveryTimeout(0)
 * 超时（默认 15s）。MCP 协议语义：MethodNotFound（-32601）视为该能力不受支持 → 空集；
 * 其余任何失败都抛出（调用方必须阻止 DB 变更/启用）。
 */
export async function discoverCapabilities(
  server: Omit<McpServerRow, 'id'>,
  isNode: boolean,
): Promise<DiscoveredCapability[]> {
  const client = new Client({ name: 'lite-ai-gateway', version: VERSION }, { jsonSchemaValidator })
  // connect / list 均不接受 signal：用 Promise.race + 超时拒绝模拟（超时后走 finally 清理）
  const signal = discoveryTimeout(0)
  const timeout = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('discovery timeout')), { once: true })
  })
  try {
    return await Promise.race([
      (async () => {
        await client.connect(createTransport(server, isNode))
        const kinds: McpCapabilityKind[] = ['tool', 'prompt', 'resource']
        const results = await Promise.allSettled(kinds.map((kind) => listAllPages(client, kind)))
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
            // 空名字无法作为能力标识，跳过
            if (name === '') continue
            caps.push({ kind, name, detail: item })
          }
        }
        return caps
      })(),
      timeout,
    ])
  } finally {
    await client.close().catch(() => {})
  }
}
