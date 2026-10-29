/** MCP 工具列表页共享逻辑：快照 detail 解析、暴露名/暴露定义文本（token 统计输入）、o200k 计数器 */
import type { McpCapabilityKind, McpToolPromptsResult } from '../../shared/api'
import { assignExposedToolNames } from '../../shared/mcp-naming'

/** 能力类型图标（工具列表与分组选择器共用） */
export const KIND_ICONS: Record<McpCapabilityKind, string> = {
  tool: 'i-lucide-wrench',
  prompt: 'i-lucide-message-square-text',
  resource: 'i-lucide-database',
}

/** 编辑目标（工具列表页 → 编辑弹窗的视图模型） */
export interface McpPromptEditTarget {
  serverId: number
  serverName: string
  kind: McpCapabilityKind
  name: string
  /** 工具在暴露范围里的名字（非工具或不在范围内为 undefined，统计时退回原名） */
  exposedToolName?: string
  detail: unknown
  defaultPrompt: string
  prompt: string
  overridden: boolean
}

/** 解析快照 detail（持久化为 JSON 字符串；非法输入 → {}） */
export function capabilityDetail(detail: unknown): Record<string, unknown> {
  if (typeof detail !== 'string') return {}
  try {
    const parsed = JSON.parse(detail)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * 暴露范围内的工具名映射（key = `${serverId}:${原名}`）。
 * 范围 = 默认组（全部 enabled servers 的全部工具），与 hub 的命名规则一致；
 * 不在范围内的工具（disabled server）不进映射，调用方按原名统计。
 */
export function exposedToolNames(servers: McpToolPromptsResult['servers']): Map<string, string> {
  const keys: string[] = []
  const entries: { serverName: string; rawName: string }[] = []
  for (const server of servers) {
    if (!server.enabled) continue
    for (const item of server.items) {
      if (item.kind !== 'tool') continue
      keys.push(`${server.server_id}:${item.name}`)
      entries.push({ serverName: server.server_name, rawName: item.name })
    }
  }
  const names = assignExposedToolNames(entries)
  return new Map(keys.map((key, i) => [key, names[i]]))
}

/**
 * 能力经 hub 暴露给客户端的定义文本，与 server/mcp/hub.ts 的 list 输出保持一致：
 * tool 名取暴露范围内的去重命名（exposedToolName，缺省退回原名），prompt 名加 `${server}__` 前缀；
 * tool 描述恒为 `[${server}] ${prompt}`；
 * prompt/resource 仅在存在覆盖时替换 description。序列化 JSON 作为 token 统计输入。
 */
export function exposedDefinitionText(
  serverName: string,
  cap: { kind: McpCapabilityKind; name: string; detail: unknown },
  prompt: string,
  overridden: boolean,
  exposedToolName?: string,
): string {
  const detail = capabilityDetail(cap.detail)
  if (cap.kind === 'tool') {
    return JSON.stringify({ ...detail, name: exposedToolName ?? cap.name, description: `[${serverName}] ${prompt}` })
  }
  const exposed: Record<string, unknown> =
    cap.kind === 'prompt' ? { ...detail, name: `${serverName}__${cap.name}` } : { ...detail }
  if (overridden) exposed.description = prompt
  return JSON.stringify(exposed)
}

type O200kCounter = (text: string) => number

let counterPromise: Promise<O200kCounter | null> | null = null

/** o200k_base 计数器（gpt-tokenizer 纯 JS，懒加载独立 chunk 并模块级缓存；加载失败 → null，UI 降级为不显示计数） */
export function loadO200kCounter(): Promise<O200kCounter | null> {
  counterPromise ??= import('gpt-tokenizer/encoding/o200k_base')
    .then((mod) => (text: string) => mod.countTokens(text))
    .catch(() => null)
  return counterPromise
}
