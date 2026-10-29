import type { H3 } from 'h3'
import { HTTPError, getQuery, readBody } from 'h3'
import { z } from 'zod'
import { requireAdmin } from '../auth.ts'
import { getDb } from '../db/index.ts'
import type { Db } from '../db/types.ts'
import { sanitizeError } from '../lib/sanitize.ts'
import { clearUpstreamCache, discoverCapabilities, testServer } from '../mcp/upstream.ts'
import type { DiscoveredCapability } from '../mcp/upstream.ts'
import { mustGet, pagingParams, parseBody, routeId } from './common.ts'
import type {
  McpCapabilitiesResult,
  McpCapabilityCounts,
  McpCapabilitySnapshot,
  McpGroupCapabilitySelection,
  McpGroupRow,
  McpGroupWithCapabilities,
  McpLogRow,
  McpPromptOverrideRow,
  McpServerRow,
  McpServerWithCounts,
  McpServerType,
  McpToolPromptsResult,
  Paged,
} from '../../shared/api.ts'

/** MCP 服务器 schema（POST 必填 name/type；其余按类型而定） */
const serverSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['stdio', 'sse', 'streamable-http']),
  command: z.string().nullable().optional(),
  args: z.string().nullable().optional(),
  env: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  headers: z.string().nullable().optional(),
  enabled: z.union([z.literal(0), z.literal(1)]).optional(),
})
const serverPatchSchema = serverSchema.partial()

/** 分组写入：web_search 为本地内置工具开关（1 开启 / 0 关闭），与能力白名单互相独立 */
const groupSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  web_search: z.union([z.literal(0), z.literal(1)]).optional(),
})
const groupPatchSchema = groupSchema.partial().extend({
  capabilities: z
    .array(
      z.object({
        server_id: z.number().int().positive(),
        kind: z.enum(['tool', 'prompt', 'resource']),
        name: z.string().min(1),
      }),
    )
    .optional(),
})

/** prompt 覆盖写入（PUT 全量；DELETE 省略 prompt） */
const promptOverrideSchema = z.object({
  server_id: z.number().int().positive(),
  kind: z.enum(['tool', 'prompt', 'resource']),
  name: z.string().min(1),
  prompt: z.string(),
})
const promptOverrideDeleteSchema = promptOverrideSchema.omit({ prompt: true })

/** args/env/headers 以 JSON 文本存储，提供时必须是合法 JSON */
function requireJsonField(name: string, value: string | null | undefined): void {
  if (value === null || value === undefined) return
  try {
    JSON.parse(value)
  } catch {
    throw new HTTPError({ status: 400, message: `${name} must be valid JSON` })
  }
}

/**
 * 按（最终生效的）类型校验必填字段：stdio 需要 command，sse / streamable-http 需要 url。
 * PUT 时 type 未传则沿用现有值再校验。
 */
function validateServerBody(body: {
  type: McpServerType
  command?: string | null
  args?: string | null
  env?: string | null
  url?: string | null
  headers?: string | null
}): void {
  if (body.type === 'stdio' && !body.command) {
    throw new HTTPError({ status: 400, message: 'stdio server requires command' })
  }
  if (body.type !== 'stdio' && !body.url) {
    throw new HTTPError({ status: 400, message: 'sse / streamable-http server requires url' })
  }
  requireJsonField('args', body.args)
  requireJsonField('env', body.env)
  requireJsonField('headers', body.headers)
}

/** 按 kind 统计快照计数 */
function countCapabilities(caps: McpCapabilitySnapshot[]): McpCapabilityCounts {
  let tools = 0
  let prompts = 0
  let resources = 0
  for (const c of caps) {
    if (c.kind === 'tool') tools++
    else if (c.kind === 'prompt') prompts++
    else resources++
  }
  return { tools, prompts, resources, total: caps.length }
}

/** 从快照 detail JSON 提取默认 prompt（description 字段；缺失/非法 → ''） */
function defaultPromptOf(detail: string): string {
  try {
    const parsed = JSON.parse(detail) as { description?: unknown } | null
    return typeof parsed?.description === 'string' ? parsed.description : ''
  } catch {
    return ''
  }
}

/** 全部 server 的能力快照，按 server_id 分组（/capabilities 与 /tools 共用） */
async function loadCapabilitiesByServer(db: Db): Promise<Map<number, McpCapabilitySnapshot[]>> {
  const rows = await db.all<McpCapabilitySnapshot>(
    `SELECT server_id, kind, name, detail FROM mcp_capabilities ORDER BY server_id, kind, name`,
  )
  const byServer = new Map<number, McpCapabilitySnapshot[]>()
  for (const r of rows) {
    const list = byServer.get(r.server_id)
    if (list) list.push(r)
    else byServer.set(r.server_id, [r])
  }
  return byServer
}

/**
 * 全量替换 server 的能力快照（先删后插；Db 接口无事务，delete 先行保证失败时
 * 不残留半套新快照——旧快照可能丢失，但绝不混入新老两代数据）。
 */
async function replaceCapabilities(db: Db, serverId: number, caps: DiscoveredCapability[]): Promise<void> {
  await db.run(`DELETE FROM mcp_capabilities WHERE server_id = ?`, serverId)
  for (const c of caps) {
    await db.run(
      `INSERT INTO mcp_capabilities (server_id, kind, name, detail) VALUES (?, ?, ?, ?)`,
      serverId,
      c.kind,
      c.name,
      JSON.stringify(c.detail),
    )
  }
}

/** 能力发现失败 → 502（错误文本过 sanitizeError，与 providers 发现一致） */
function discoveryError(error: unknown): HTTPError {
  const message = error instanceof Error ? error.message : String(error)
  return new HTTPError({ status: 502, message: sanitizeError(message) })
}

export function registerMcp(app: H3): void {
  // ---------- MCP 服务器 ----------

  app.get('/api/admin/mcp/servers', async (event) => {
    requireAdmin(event)
    // 附能力快照计数（分组/详情 UI 用）
    return getDb(event).all<McpServerWithCounts>(
      `SELECT s.*,
        (SELECT count(*) FROM mcp_capabilities c WHERE c.server_id = s.id AND c.kind = 'tool') AS tool_count,
        (SELECT count(*) FROM mcp_capabilities c WHERE c.server_id = s.id AND c.kind = 'prompt') AS prompt_count,
        (SELECT count(*) FROM mcp_capabilities c WHERE c.server_id = s.id AND c.kind = 'resource') AS resource_count
       FROM mcp_servers s ORDER BY s.id`,
    )
  })

  app.post('/api/admin/mcp/servers', async (event) => {
    requireAdmin(event)
    const body = parseBody(serverSchema, await readBody(event))
    validateServerBody(body)
    const db = getDb(event)
    const enabled = body.enabled ?? 1
    // 创建即发现（无论 enabled）：任一 list 失败（MethodNotFound 之外）→ 不落库
    let discovered: DiscoveredCapability[]
    try {
      discovered = await discoverCapabilities(
        {
          name: body.name,
          type: body.type,
          command: body.command ?? null,
          args: body.args ?? null,
          env: body.env ?? null,
          url: body.url ?? null,
          headers: body.headers ?? null,
          enabled,
        },
        event.runtime?.name === 'node',
      )
    } catch (error) {
      throw discoveryError(error)
    }
    await db.run(
      `INSERT INTO mcp_servers (name, type, command, args, env, url, headers, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      body.name,
      body.type,
      body.command ?? null,
      body.args ?? null,
      body.env ?? null,
      body.url ?? null,
      body.headers ?? null,
      enabled,
    )
    // name 唯一，回查拿完整行
    const row = await mustGet<McpServerRow>(db, `SELECT * FROM mcp_servers WHERE name = ?`, body.name)
    await replaceCapabilities(db, row.id, discovered)
    return row
  })

  app.put('/api/admin/mcp/servers/:id', async (event) => {
    requireAdmin(event)
    const id = routeId(event)
    const body = parseBody(serverPatchSchema, await readBody(event))
    const db = getDb(event)
    const existing = await db.get<McpServerRow>(`SELECT * FROM mcp_servers WHERE id = ?`, id)
    if (!existing) throw new HTTPError({ status: 404, message: 'mcp server not found' })
    // 以最终生效的字段做类型校验（未传时沿用现有值）
    const effective = {
      ...existing,
      name: body.name ?? existing.name,
      type: body.type ?? existing.type,
      command: body.command !== undefined ? body.command : existing.command,
      args: body.args !== undefined ? body.args : existing.args,
      env: body.env !== undefined ? body.env : existing.env,
      url: body.url !== undefined ? body.url : existing.url,
      headers: body.headers !== undefined ? body.headers : existing.headers,
      enabled: body.enabled ?? existing.enabled,
    }
    validateServerBody(effective)
    // 禁用 → 启用：先发现，失败则不更新（不启用、不替换快照）
    let discovered: DiscoveredCapability[] | null = null
    if (existing.enabled === 0 && effective.enabled === 1) {
      try {
        discovered = await discoverCapabilities(effective, event.runtime?.name === 'node')
      } catch (error) {
        throw discoveryError(error)
      }
    }
    const sets: string[] = []
    const params: (string | number | null)[] = []
    if (body.name !== undefined) {
      sets.push('name = ?')
      params.push(body.name)
    }
    if (body.type !== undefined) {
      sets.push('type = ?')
      params.push(body.type)
    }
    if (body.command !== undefined) {
      sets.push('command = ?')
      params.push(body.command)
    }
    if (body.args !== undefined) {
      sets.push('args = ?')
      params.push(body.args)
    }
    if (body.env !== undefined) {
      sets.push('env = ?')
      params.push(body.env)
    }
    if (body.url !== undefined) {
      sets.push('url = ?')
      params.push(body.url)
    }
    if (body.headers !== undefined) {
      sets.push('headers = ?')
      params.push(body.headers)
    }
    if (body.enabled !== undefined) {
      sets.push('enabled = ?')
      params.push(body.enabled)
    }
    if (sets.length > 0) {
      await db.run(`UPDATE mcp_servers SET ${sets.join(', ')} WHERE id = ?`, ...params, id)
    }
    const row = await mustGet<McpServerRow>(db, `SELECT * FROM mcp_servers WHERE id = ?`, id)
    if (discovered !== null) await replaceCapabilities(db, row.id, discovered)
    return row
  })

  app.delete('/api/admin/mcp/servers/:id', async (event) => {
    requireAdmin(event)
    const id = routeId(event)
    // 快照/分组选择关系靠外键级联删除
    await getDb(event).run(`DELETE FROM mcp_servers WHERE id = ?`, id)
    return { ok: true }
  })

  // 测试连接：建 client + listTools，返回工具数 / 错误（错误文本已由 testServer 过 sanitizeError）
  app.post('/api/admin/mcp/servers/:id/test', async (event) => {
    requireAdmin(event)
    const id = routeId(event)
    const db = getDb(event)
    const server = await db.get<McpServerRow>(`SELECT * FROM mcp_servers WHERE id = ?`, id)
    if (!server) throw new HTTPError({ status: 404, message: 'mcp server not found' })
    return testServer(server, event.runtime?.name === 'node')
  })

  // 全部 server 的能力快照（分组选择 UI 用）：每 server 明细 + 计数
  app.get('/api/admin/mcp/capabilities', async (event) => {
    requireAdmin(event)
    const db = getDb(event)
    const servers = await db.all<{ id: number; name: string }>(`SELECT id, name FROM mcp_servers ORDER BY id`)
    const byServer = await loadCapabilitiesByServer(db)
    const result: McpCapabilitiesResult = {
      servers: servers.map((s) => {
        const capabilities = byServer.get(s.id) ?? []
        return { server_id: s.id, server_name: s.name, capabilities, counts: countCapabilities(capabilities) }
      }),
    }
    return result
  })

  // ---------- MCP 工具 prompt ----------

  // 全部 server 的能力 + prompt 覆盖（工具列表页）：生效 prompt = 覆盖 ?? 快照 description
  app.get('/api/admin/mcp/tools', async (event) => {
    requireAdmin(event)
    const db = getDb(event)
    const servers = await db.all<McpServerRow>(`SELECT * FROM mcp_servers ORDER BY id`)
    const byServer = await loadCapabilitiesByServer(db)
    const overrides = await db.all<McpPromptOverrideRow>(`SELECT * FROM mcp_prompt_overrides`)
    const overrideMap = new Map(overrides.map((o) => [`${o.server_id}:${o.kind}:${o.name}`, o.prompt]))
    const result: McpToolPromptsResult = {
      servers: servers.map((s) => ({
        server_id: s.id,
        server_name: s.name,
        server_type: s.type,
        enabled: s.enabled,
        items: (byServer.get(s.id) ?? []).map((c) => {
          const fallback = defaultPromptOf(c.detail)
          const custom = overrideMap.get(`${c.server_id}:${c.kind}:${c.name}`)
          return {
            kind: c.kind,
            name: c.name,
            detail: c.detail,
            default_prompt: fallback,
            prompt: custom ?? fallback,
            overridden: (custom !== undefined ? 1 : 0) as 0 | 1,
          }
        }),
      })),
    }
    return result
  })

  // 编辑 prompt：能力必须存在于快照；文本与默认一致时直接清除覆盖（等效恢复默认）
  app.put('/api/admin/mcp/prompts', async (event) => {
    requireAdmin(event)
    const body = parseBody(promptOverrideSchema, await readBody(event))
    const db = getDb(event)
    const cap = await db.get<{ detail: string }>(
      `SELECT detail FROM mcp_capabilities WHERE server_id = ? AND kind = ? AND name = ?`,
      body.server_id,
      body.kind,
      body.name,
    )
    if (!cap) {
      throw new HTTPError({ status: 400, message: `unknown capability ${body.server_id}:${body.kind}:${body.name}` })
    }
    if (body.prompt === defaultPromptOf(cap.detail)) {
      await db.run(
        `DELETE FROM mcp_prompt_overrides WHERE server_id = ? AND kind = ? AND name = ?`,
        body.server_id,
        body.kind,
        body.name,
      )
      return { ok: true, overridden: 0 }
    }
    await db.run(
      `INSERT INTO mcp_prompt_overrides (server_id, kind, name, prompt, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT (server_id, kind, name)
       DO UPDATE SET prompt = excluded.prompt, updated_at = excluded.updated_at`,
      body.server_id,
      body.kind,
      body.name,
      body.prompt,
    )
    return { ok: true, overridden: 1 }
  })

  // 恢复默认：删除覆盖行（不存在也幂等成功）
  app.delete('/api/admin/mcp/prompts', async (event) => {
    requireAdmin(event)
    const body = parseBody(promptOverrideDeleteSchema, await readBody(event))
    await getDb(event).run(
      `DELETE FROM mcp_prompt_overrides WHERE server_id = ? AND kind = ? AND name = ?`,
      body.server_id,
      body.kind,
      body.name,
    )
    return { ok: true }
  })

  // ---------- MCP 分组 ----------

  // 分组列表：附带能力白名单 + 本地 web_search 开关（一次全量读开启表，不逐组查询）
  app.get('/api/admin/mcp/groups', async (event) => {
    requireAdmin(event)
    const db = getDb(event)
    const groups = await db.all<McpGroupRow>(`SELECT * FROM mcp_groups ORDER BY id`)
    const members = await db.all<{ group_id: number } & McpGroupCapabilitySelection>(
      `SELECT group_id, server_id, kind, name FROM mcp_group_capabilities`,
    )
    const byGroup = new Map<number, McpGroupCapabilitySelection[]>()
    for (const m of members) {
      const list = byGroup.get(m.group_id)
      if (list) list.push({ server_id: m.server_id, kind: m.kind, name: m.name })
      else byGroup.set(m.group_id, [{ server_id: m.server_id, kind: m.kind, name: m.name }])
    }
    const webSearchGroups = await db.all<{ group_id: number }>(`SELECT group_id FROM mcp_group_web_search`)
    const webSearchOn = new Set(webSearchGroups.map((r) => r.group_id))
    const result: McpGroupWithCapabilities[] = groups.map((g) => ({
      ...g,
      capabilities: byGroup.get(g.id) ?? [],
      web_search: webSearchOn.has(g.id) ? 1 : 0,
    }))
    return result
  })

  app.post('/api/admin/mcp/groups', async (event) => {
    requireAdmin(event)
    const body = parseBody(groupSchema, await readBody(event))
    const db = getDb(event)
    await db.run(`INSERT INTO mcp_groups (name, description) VALUES (?, ?)`, body.name, body.description ?? '')
    // name 唯一，回查拿完整行
    const row = await mustGet<McpGroupRow>(db, `SELECT * FROM mcp_groups WHERE name = ?`, body.name)
    // 新建组默认没有能力选择；只有显式 1 才写入开启行
    if (body.web_search === 1) {
      await db.run(`INSERT OR IGNORE INTO mcp_group_web_search (group_id) VALUES (?)`, row.id)
    }
    const result: McpGroupWithCapabilities = { ...row, capabilities: [], web_search: body.web_search === 1 ? 1 : 0 }
    return result
  })

  app.put('/api/admin/mcp/groups/:id', async (event) => {
    requireAdmin(event)
    const id = routeId(event)
    const body = parseBody(groupPatchSchema, await readBody(event))
    const db = getDb(event)
    const exists = await db.get(`SELECT id FROM mcp_groups WHERE id = ?`, id)
    if (!exists) throw new HTTPError({ status: 404, message: 'mcp group not found' })
    // 先校验能力白名单：无效请求不能先改掉组名/描述/搜索开关（一次读出涉及 server 的快照键集合）
    if (body.capabilities !== undefined && body.capabilities.length > 0) {
      const serverIds = [...new Set(body.capabilities.map((c) => c.server_id))]
      const rows = await db.all<{ server_id: number; kind: string; name: string }>(
        `SELECT server_id, kind, name FROM mcp_capabilities
          WHERE server_id IN (${serverIds.map(() => '?').join(', ')})`,
        ...serverIds,
      )
      const known = new Set(rows.map((r) => `${r.server_id}:${r.kind}:${r.name}`))
      for (const c of body.capabilities) {
        if (!known.has(`${c.server_id}:${c.kind}:${c.name}`)) {
          throw new HTTPError({
            status: 400,
            message: `unknown capability ${c.server_id}:${c.kind}:${c.name}`,
          })
        }
      }
    }
    const sets: string[] = []
    const params: (string | number)[] = []
    if (body.name !== undefined) {
      sets.push('name = ?')
      params.push(body.name)
    }
    if (body.description !== undefined) {
      sets.push('description = ?')
      params.push(body.description)
    }
    if (sets.length > 0) {
      await db.run(`UPDATE mcp_groups SET ${sets.join(', ')} WHERE id = ?`, ...params, id)
    }
    // capabilities 存在则全量替换能力白名单（先删后插；空数组 = 清空该组全部选择）
    if (body.capabilities !== undefined) {
      await db.run(`DELETE FROM mcp_group_capabilities WHERE group_id = ?`, id)
      for (const c of body.capabilities) {
        await db.run(
          `INSERT OR IGNORE INTO mcp_group_capabilities (group_id, server_id, kind, name) VALUES (?, ?, ?, ?)`,
          id,
          c.server_id,
          c.kind,
          c.name,
        )
      }
    }
    // web_search 省略保留现状；1 → 开启行，0 → 删行
    if (body.web_search === 1) {
      await db.run(`INSERT OR IGNORE INTO mcp_group_web_search (group_id) VALUES (?)`, id)
    } else if (body.web_search === 0) {
      await db.run(`DELETE FROM mcp_group_web_search WHERE group_id = ?`, id)
    }
    const row = await mustGet<McpGroupRow>(db, `SELECT * FROM mcp_groups WHERE id = ?`, id)
    const members = await db.all<McpGroupCapabilitySelection>(
      `SELECT server_id, kind, name FROM mcp_group_capabilities WHERE group_id = ?`,
      id,
    )
    const webSearch = await db.get<{ group_id: number }>(`SELECT group_id FROM mcp_group_web_search WHERE group_id = ?`, id)
    const result: McpGroupWithCapabilities = { ...row, capabilities: members, web_search: webSearch ? 1 : 0 }
    return result
  })

  app.delete('/api/admin/mcp/groups/:id', async (event) => {
    requireAdmin(event)
    const id = routeId(event)
    // 能力选择与 web_search 开启行都靠外键级联删除，无需手工清理
    await getDb(event).run(`DELETE FROM mcp_groups WHERE id = ?`, id)
    return { ok: true }
  })

  // ---------- MCP 日志与缓存 ----------

  // MCP 调用日志：分页 + 过滤（server_name LIKE / method），ts 倒序
  app.get('/api/admin/mcp/logs', async (event) => {
    requireAdmin(event)
    const db = getDb(event)
    const q = getQuery(event)

    const { limit, offset } = pagingParams(event)

    const where: string[] = []
    const params: (string | number)[] = []
    if (typeof q.server === 'string' && q.server) {
      where.push('server_name LIKE ?')
      params.push(`%${q.server}%`)
    }
    if (typeof q.method === 'string' && q.method) {
      where.push('method = ?')
      params.push(q.method)
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''

    const totalRow = await mustGet<{ total: number }>(db, `SELECT count(*) AS total FROM mcp_logs${whereSql}`, ...params)
    const rows = await db.all<McpLogRow>(
      `SELECT * FROM mcp_logs${whereSql} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    )
    const result: Paged<McpLogRow> = { rows, total: totalRow.total }
    return result
  })

  // 清空上游连接缓存，下次请求惰性重连
  app.post('/api/admin/mcp/reload', async (event) => {
    requireAdmin(event)
    clearUpstreamCache()
    return { ok: true }
  })
}
