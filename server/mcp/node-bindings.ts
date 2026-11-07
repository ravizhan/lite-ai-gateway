import type { H3 } from 'h3'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

/**
 * Node-only MCP 能力注入点（仿 db/index.ts 的 setNodeDb 模式）。
 * 本模块无任何 node: 依赖，可安全进入 Workers bundle；实现由 Node 入口在
 * createApp() 之前注入（见 mcp/bindings-node.ts）。
 */
/** web_fetch 单跳响应（不跟随重定向）；body 为已解压的字节流 */
export interface WebFetchHop {
  status: number
  statusText: string
  headers: Headers
  body: ReadableStream<Uint8Array> | null
}

/** 目标不是公网地址（静态 URL 检查或 Node 连接层 DNS 检查抛出） */
export class WebFetchBlockedError extends Error {
  constructor(detail: string) {
    super(`blocked non-public address: ${detail}`)
    this.name = 'WebFetchBlockedError'
  }
}

export interface NodeMcpBindings {
  registerNodeSse: (app: H3) => void
  createStdioTransport: (opts: {
    command: string
    args: string[]
    env: Record<string, string>
  }) => Transport
  createSseTransport: (url: URL, headers: Record<string, string>) => Transport
  /** web_fetch 单跳 GET：连接层校验 DNS 结果只能是公网地址 */
  webFetchHop: (url: URL, headers: Headers, signal: AbortSignal) => Promise<WebFetchHop>
}

let bindings: NodeMcpBindings | null = null

/** 由 server/node.ts 启动时注入 Node 端 MCP 传输层（node:child_process/eventsource 不进入 Workers bundle） */
export function setNodeMcpBindings(b: NodeMcpBindings): void {
  bindings = b
}

/** 运行时差异唯一点：stdio/SSE 上游与 Node SSE 端点仅 Node 可用 */
export function getNodeMcpBindings(): NodeMcpBindings {
  if (!bindings) throw new Error('node MCP bindings not registered (only available in Node runtime)')
  return bindings
}
