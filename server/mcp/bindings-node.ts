import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { setNodeMcpBindings } from './node-bindings.ts'
import { registerNodeSse } from './sse-node.ts'

/**
 * Node-only 实现：静态 import 全部 Node-only 模块（node:child_process/eventsource/node:http）。
 * 只被 server/node.ts 引入，Workers 入口不碰本文件。
 */
export function installNodeMcpBindings(): void {
  setNodeMcpBindings({
    registerNodeSse,
    createStdioTransport: ({ command, args, env }) =>
      new StdioClientTransport({ command, args, env: { ...getDefaultEnvironment(), ...env } }),
    createSseTransport: (url, headers) => new SSEClientTransport(url, { requestInit: { headers } }),
  })
}
