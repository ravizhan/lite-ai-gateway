import { H3 } from 'h3'
import { adminMw, apiKeyMw } from './auth.ts'
import { registerAdmin } from './admin/index.ts'
import { registerLlm } from './llm/routes.ts'
import { registerMcp } from './mcp/routes.ts'

/**
 * 运行时无关的 H3 应用组装。
 * 运行时差异只有两个注入点：getDb(event)（db/index.ts）与 MCP stdio/SSE 能力（registerMcp 的 runtime 参数）。
 * Node 入口额外挂载静态资源（server/node.ts），Workers 由 Assets 负责前端。
 * runtime 由入口显式传入（Node 端在 createApp 前注入 node-only 传输层，Workers bundle 不含）。
 */
export async function createApp(runtime: 'node' | 'workers'): Promise<H3> {
  const app = new H3()

  // 认证中间件（h3 v2 rou3：'/mcp' 精确匹配 /mcp 本身；'/mcp/*' 单段通配 :group。
  // 不能用 '/mcp/**'：双星通配会越界匹配 /mcps 等共享前缀的 SPA 前端路由。
  // MCP/SSE 协议路径均为单段（/mcp/:group、/sse/:group、/messages），/* 单段通配足够。）
  // MCP 端点与 LLM 端点统一使用 api_keys 认证（无独立 MCP key）
  app.use('/api/admin/**', adminMw)
  app.use('/v1/**', apiKeyMw)
  app.use('/mcp', apiKeyMw)
  app.use('/mcp/*', apiKeyMw)
  app.use('/sse', apiKeyMw)
  app.use('/sse/*', apiKeyMw)
  app.use('/messages', apiKeyMw)

  registerAdmin(app)
  registerLlm(app)
  await registerMcp(app, runtime)

  return app
}
