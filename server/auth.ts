import { createError, onRequest, type H3Event } from 'h3'
import { getDb } from './db/index.ts'

/** 管理端 token：Workers 取 env（wrangler vars / secret），Node 取 process.env */
function adminToken(event: H3Event): string | undefined {
  const cf = event.runtime?.cloudflare
  if (cf) {
    return (cf.env as unknown as { ADMIN_TOKEN?: string }).ADMIN_TOKEN
  }
  return process.env.ADMIN_TOKEN
}

/** 管理端认证：`Authorization: Bearer <ADMIN_TOKEN>`；未配置 token 返回 500，不匹配返回 401 */
export function requireAdmin(event: H3Event): void {
  const token = adminToken(event)
  if (!token) {
    throw createError({ status: 500, message: 'ADMIN_TOKEN not configured' })
  }
  if (event.req.headers.get('authorization') !== `Bearer ${token}`) {
    throw createError({ status: 401, message: 'unauthorized' })
  }
}

/** 从 Authorization 头提取 Bearer token（大小写不敏感），无则 undefined */
function bearerToken(event: H3Event): string | undefined {
  const auth = event.req.headers.get('authorization')
  if (!auth) return undefined
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
  return m ? m[1].trim() : undefined
}

/** LLM 端点认证：查 api_keys（enabled=1），命中挂 event.context.apiKeyId */
export async function requireApiKey(event: H3Event): Promise<void> {
  const token = bearerToken(event)
  if (!token) {
    throw createError({ status: 401, message: 'unauthorized' })
  }
  const row = await getDb(event).get<{ id: number }>(
    'SELECT id FROM api_keys WHERE key = ? AND enabled = 1',
    token,
  )
  if (!row) {
    throw createError({ status: 401, message: 'unauthorized' })
  }
  event.context.apiKeyId = row.id
}

// 中间件工厂：app.use('/api/admin/**', adminMw) / app.use('/v1/**', apiKeyMw) / app.use('/mcp/**', apiKeyMw)
export const adminMw = onRequest((event) => {
  requireAdmin(event)
})
export const apiKeyMw = onRequest(async (event) => {
  await requireApiKey(event)
})
