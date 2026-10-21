import type { H3 } from 'h3'
import { getDb } from '../db/index.ts'
import { relayEmbeddings } from './embed.ts'
import { relayChat, relayResponses } from './relay.ts'

/**
 * LLM 中转公开端点。
 * 认证（api key）由父级在 app.ts 通过 app.use('/v1/**', apiKeyMw) 统一挂载
 * （见 server/auth.ts requireApiKey，校验通过后挂 event.context.apiKeyId），
 * 各 handler 不再重复校验；relay 只读取中间件写入的 apiKeyId。
 */
export function registerLlm(app: H3): void {
  app.post('/v1/chat/completions', relayChat)
  app.post('/v1/responses', relayResponses)
  app.post('/v1/embeddings', relayEmbeddings)

  // 网关模型列表（仅对外 id）：model_routes 出现过的模型名 ∪ models 表 enabled 行的
  // 对外 id（alias 优先；禁用模型与映射前的原始模型名均不暴露，UNION 去重）
  app.get('/v1/models', async (event) => {
    const db = getDb(event)
    const rows = await db.all<{ model: string }>(
      `SELECT model FROM model_routes
       UNION
       SELECT COALESCE(NULLIF(alias, ''), model) FROM models WHERE enabled = 1`,
    )
    const data = rows.map((r) => ({
      id: r.model,
      object: 'model',
      created: 0,
      owned_by: 'lite-ai-gateway',
    }))
    return new Response(JSON.stringify({ object: 'list', data }), {
      headers: { 'content-type': 'application/json' },
    })
  })
}
