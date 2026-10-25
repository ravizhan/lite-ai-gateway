import type { H3, H3Event } from 'h3'
import { HTTPError, getRouterParam, readBody } from 'h3'
import { z } from 'zod'
import { requireAdmin } from '../auth.ts'
import { getDb } from '../db/index.ts'
import type { Db } from '../db/types.ts'
import { sanitizeError } from '../lib/sanitize.ts'
import { checkTransformSyntax } from '../lib/transform.ts'
import { previewSearchTransform } from '../mcp/search.ts'
import { MCP_SEARCH_PRESETS } from '../mcp/search-presets.ts'
import { WEB_SEARCH_TOOL, webSearchRequestSchema } from '../../shared/mcp-search.ts'
import type {
  McpSearchPresetsResult,
  McpSearchUpstreamItem,
  McpSearchUpstreamRow,
} from '../../shared/mcp-search.ts'
import type { McpServerType } from '../../shared/api.ts'

/** 转换代码上限：与绑定表 TEXT 列的实际使用上限一致（非空） */
const MAX_CODE_LENGTH = 65536
/** 上游原始工具名上限 */
const MAX_TOOL_NAME_LENGTH = 128

/** 绑定字段（不含默认值：PUT 的 partial 不能因缺省键补出默认值而覆盖原值） */
const upstreamShape = {
  server_id: z.number().int().positive(),
  tool_name: z.string().trim().min(1).max(MAX_TOOL_NAME_LENGTH),
  enabled: z.union([z.literal(0), z.literal(1)]),
  request_code: z.string().min(1).max(MAX_CODE_LENGTH),
  response_code: z.string().min(1).max(MAX_CODE_LENGTH),
  preset_id: z.enum(['tavily', 'exa-advanced', 'firecrawl']).nullable(),
  preset_version: z.number().int().positive().nullable(),
}

/**
 * 绑定写入：POST 全量（enabled/preset 有默认值）。
 * 来源版本不是自动继承指针：要么两者都为空（自定义），要么同时记录预置 id 与版本；
 * 校验的是合并后的完整值，POST 与 PUT 共用。
 */
const upstreamSchema = z
  .object({
    ...upstreamShape,
    enabled: upstreamShape.enabled.default(1),
    preset_id: upstreamShape.preset_id.default(null),
    preset_version: upstreamShape.preset_version.default(null),
  })
  .superRefine((value, ctx) => {
    if ((value.preset_id === null) !== (value.preset_version === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'preset_id and preset_version must be provided together',
        path: ['preset_id'],
      })
    }
  })

/** PUT：partial 后与现有行合并，再走 upstreamSchema 的全量校验 */
const upstreamPatchSchema = z.object(upstreamShape).partial()

/** 预览：request 方向只跑请求转换；response 方向额外接收原始 MCP 结果 */
const previewSchema = z.discriminatedUnion('stage', [
  z.object({ stage: z.literal('request'), code: z.string(), request: webSearchRequestSchema }),
  z.object({
    stage: z.literal('response'),
    code: z.string(),
    request: webSearchRequestSchema,
    response: z.record(z.string(), z.unknown()),
  }),
])

/** zod 校验失败 → 400 + issues */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new HTTPError({ status: 400, message: 'invalid body', data: parsed.error.issues })
  }
  return parsed.data
}

/** 路由参数 id 解析（非法 → 400） */
function routeId(event: H3Event): number {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) throw new HTTPError({ status: 400, message: 'invalid id' })
  return id
}

/** 列表/单条查询：JOIN 服务器展示信息 + 能力快照可用性（不触发发现、不带凭据） */
const ITEM_SELECT = `SELECT u.id, u.server_id, u.tool_name, u.enabled, u.request_code, u.response_code,
    u.preset_id, u.preset_version,
    s.name AS server_name, s.type AS server_type, s.enabled AS server_enabled,
    CASE WHEN EXISTS (
      SELECT 1 FROM mcp_capabilities c
       WHERE c.server_id = u.server_id AND c.kind = 'tool' AND c.name = u.tool_name
    ) THEN 1 ELSE 0 END AS tool_available
  FROM mcp_search_upstreams u
  JOIN mcp_servers s ON s.id = u.server_id`

interface SearchUpstreamRow extends McpSearchUpstreamRow {
  server_name: string
  server_type: McpServerType
  server_enabled: number
  tool_available: number
}

/** SQLite 的 UNIQUE 冲突（node:sqlite / D1 文本一致）→ 并发重复绑定统一映射 409 */
function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /unique constraint failed/i.test(message)
}

function duplicateError(): HTTPError {
  return new HTTPError({ status: 409, message: 'search tool already configured for this server' })
}

/** 目标服务器必须存在，且其能力快照里仍有同名原始工具（不因保存转换而清缓存/重新发现） */
async function requireSearchableTool(db: Db, serverId: number, toolName: string): Promise<void> {
  const server = await db.get(`SELECT id FROM mcp_servers WHERE id = ?`, serverId)
  if (!server) throw new HTTPError({ status: 404, message: 'mcp server not found' })
  const capability = await db.get(
    `SELECT 1 FROM mcp_capabilities WHERE server_id = ? AND kind = 'tool' AND name = ?`,
    serverId,
    toolName,
  )
  if (!capability) {
    throw new HTTPError({ status: 400, message: 'search tool not found in capability snapshot' })
  }
}

/** 同一 (server_id, tool_name) 只能有一条绑定；PUT 时排除自身 */
async function requireUniqueBinding(
  db: Db,
  serverId: number,
  toolName: string,
  excludeId: number | null,
): Promise<void> {
  const row = await db.get<{ id: number }>(
    `SELECT id FROM mcp_search_upstreams WHERE server_id = ? AND tool_name = ?`,
    serverId,
    toolName,
  )
  if (row && row.id !== excludeId) throw duplicateError()
}

/** 只做语法/函数形状检查（不调用函数、不连上游）；错误文本脱敏并带字段前缀 */
async function requireTransformSyntax(
  field: 'request_code' | 'response_code',
  code: string,
): Promise<void> {
  const error = await checkTransformSyntax(code)
  if (error !== null) {
    throw new HTTPError({ status: 400, message: `invalid ${field}: ${sanitizeError(error)}` })
  }
}

/** 读回单条绑定（写入后的完整响应） */
async function readItem(db: Db, id: number): Promise<McpSearchUpstreamItem> {
  const row = await db.get<SearchUpstreamRow>(`${ITEM_SELECT} WHERE u.id = ?`, id)
  if (!row) throw new HTTPError({ status: 500, message: 'failed to read search upstream' })
  // tool_available 归一为 0 | 1（CASE EXISTS 已返回 0/1，这里只收窄类型）
  return { ...row, tool_available: row.tool_available === 1 ? 1 : 0 }
}

/** 搜索上游绑定 + 纯转换预览（管理 API；每个 handler 内 requireAdmin） */
export function registerMcpSearch(app: H3): void {
  // ---------- 上游绑定 ----------

  app.get('/api/admin/mcp/search/upstreams', async (event) => {
    requireAdmin(event)
    const rows = await getDb(event).all<SearchUpstreamRow>(`${ITEM_SELECT} ORDER BY u.id`)
    return rows.map((row) => ({ ...row, tool_available: row.tool_available === 1 ? 1 : 0 }))
  })

  app.post('/api/admin/mcp/search/upstreams', async (event) => {
    requireAdmin(event)
    const body = parseBody(upstreamSchema, await readBody(event))
    const db = getDb(event)
    // 全部校验通过后才写：坏工具名/坏脚本不会留下半个绑定
    await requireSearchableTool(db, body.server_id, body.tool_name)
    await requireUniqueBinding(db, body.server_id, body.tool_name, null)
    await requireTransformSyntax('request_code', body.request_code)
    await requireTransformSyntax('response_code', body.response_code)
    try {
      await db.run(
        `INSERT INTO mcp_search_upstreams
           (server_id, tool_name, enabled, request_code, response_code, preset_id, preset_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        body.server_id,
        body.tool_name,
        body.enabled,
        body.request_code,
        body.response_code,
        body.preset_id,
        body.preset_version,
      )
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateError()
      throw error
    }
    const row = await db.get<{ id: number }>(
      `SELECT id FROM mcp_search_upstreams WHERE server_id = ? AND tool_name = ?`,
      body.server_id,
      body.tool_name,
    )
    if (!row) throw new HTTPError({ status: 500, message: 'failed to read inserted row' })
    return readItem(db, row.id)
  })

  app.put('/api/admin/mcp/search/upstreams/:id', async (event) => {
    requireAdmin(event)
    const id = routeId(event)
    const body = parseBody(upstreamPatchSchema, await readBody(event))
    if (Object.keys(body).length === 0) {
      throw new HTTPError({ status: 400, message: 'empty update body' })
    }
    const db = getDb(event)
    const existing = await db.get<McpSearchUpstreamRow>(`SELECT * FROM mcp_search_upstreams WHERE id = ?`, id)
    if (!existing) throw new HTTPError({ status: 404, message: 'search upstream not found' })
    // 省略字段保留原值，再按完整行统一校验（含 preset 成对约束）
    const merged = parseBody(upstreamSchema, {
      server_id: body.server_id ?? existing.server_id,
      tool_name: body.tool_name ?? existing.tool_name,
      enabled: body.enabled ?? existing.enabled,
      request_code: body.request_code ?? existing.request_code,
      response_code: body.response_code ?? existing.response_code,
      preset_id: body.preset_id !== undefined ? body.preset_id : existing.preset_id,
      preset_version: body.preset_version !== undefined ? body.preset_version : existing.preset_version,
    })
    // 只有目标变化或从禁用切到启用才要求快照里仍有该工具：
    // 改脚本、单纯停用必须允许，即使原始工具已从快照消失
    const targetChanged = merged.server_id !== existing.server_id || merged.tool_name !== existing.tool_name
    const enabling = existing.enabled === 0 && merged.enabled === 1
    if (targetChanged || enabling) {
      await requireSearchableTool(db, merged.server_id, merged.tool_name)
    }
    if (targetChanged) {
      await requireUniqueBinding(db, merged.server_id, merged.tool_name, id)
    }
    if (body.request_code !== undefined) await requireTransformSyntax('request_code', merged.request_code)
    if (body.response_code !== undefined) await requireTransformSyntax('response_code', merged.response_code)
    try {
      await db.run(
        `UPDATE mcp_search_upstreams
            SET server_id = ?, tool_name = ?, enabled = ?, request_code = ?, response_code = ?,
                preset_id = ?, preset_version = ?
          WHERE id = ?`,
        merged.server_id,
        merged.tool_name,
        merged.enabled,
        merged.request_code,
        merged.response_code,
        merged.preset_id,
        merged.preset_version,
        id,
      )
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateError()
      throw error
    }
    return readItem(db, id)
  })

  app.delete('/api/admin/mcp/search/upstreams/:id', async (event) => {
    requireAdmin(event)
    const id = routeId(event)
    const db = getDb(event)
    const existing = await db.get(`SELECT id FROM mcp_search_upstreams WHERE id = ?`, id)
    if (!existing) throw new HTTPError({ status: 404, message: 'search upstream not found' })
    // 只删绑定，不删服务器；服务器删除时靠外键级联清理
    await db.run(`DELETE FROM mcp_search_upstreams WHERE id = ?`, id)
    return { ok: true }
  })

  // ---------- 预置与预览 ----------

  // 预置代码只是起点：应用后复制进绑定行，运行时只读绑定行代码
  app.get('/api/admin/mcp/search/presets', async (event) => {
    requireAdmin(event)
    const result: McpSearchPresetsResult = {
      tool: WEB_SEARCH_TOOL,
      presets: MCP_SEARCH_PRESETS,
    }
    return result
  })

  // 纯转换预览：不读库、不连上游；任何失败都是 400
  app.post('/api/admin/mcp/search/preview', async (event) => {
    requireAdmin(event)
    const body = parseBody(previewSchema, await readBody(event))
    try {
      if (body.stage === 'response') {
        return await previewSearchTransform({
          stage: 'response',
          code: body.code,
          request: body.request,
          response: body.response,
        })
      }
      return await previewSearchTransform({ stage: 'request', code: body.code, request: body.request })
    } catch (error) {
      if (error instanceof HTTPError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new HTTPError({ status: 400, message: sanitizeError(message) })
    }
  })
}
