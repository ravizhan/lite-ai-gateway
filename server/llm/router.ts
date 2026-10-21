import type { Db } from '../db/types.ts'
import type { ProviderRow } from '../../shared/api.ts'

/** 路由解析结果：ProviderRow 全字段 + 该 exact model/provider 组合的 route 并发上限 */
export interface RoutedProvider extends ProviderRow {
  route_max_concurrency: number
  /** 该 provider 实际应发往上游的模型 id（alias 映射后的原始 model）；与请求的对外 id 相同时等于请求值 */
  upstream_model: string
}

export type RouteProtocol = 'chat' | 'responses' | 'embedding'

export interface ExplicitRouteUnavailable {
  matched: true
  model: string
  provider: null
  status: 400 | 404
  message: string
}

export interface ExplicitRouteResolved {
  matched: true
  model: string
  provider: RoutedProvider
}

export interface NoExplicitRoute {
  matched: false
  model: string
}

export type ExplicitRouteResult = ExplicitRouteUnavailable | ExplicitRouteResolved | NoExplicitRoute

/**
 * Resolve the optional `provider/model` request form. Provider names are matched
 * exactly before the slash, with the longest configured name winning when names
 * themselves contain slashes. A recognized provider never falls back to another
 * provider when its model, route, capability, or enabled state is unavailable.
 */
export async function resolveExplicitRoute(
  db: Db,
  requestedModel: string,
  protocol: RouteProtocol,
): Promise<ExplicitRouteResult> {
  const slash = requestedModel.indexOf('/')
  if (slash <= 0) return { matched: false, model: requestedModel }

  const providers = await db.all<ProviderRow>(
    'SELECT * FROM providers ORDER BY length(name) DESC, id ASC',
  )
  const provider = providers.find((candidate) => requestedModel.startsWith(`${candidate.name}/`))
  if (!provider) return { matched: false, model: requestedModel }

  const model = requestedModel.slice(provider.name.length + 1)
  if (model.length === 0) {
    return {
      matched: true,
      model,
      provider: null,
      status: 400,
      message: 'missing model name after provider prefix',
    }
  }

  const unavailable = (): ExplicitRouteUnavailable => ({
    matched: true,
    model,
    provider: null,
    status: 404,
    message: `no provider for model ${requestedModel}`,
  })
  if (provider.enabled !== 1) return unavailable()
  if (protocol !== 'embedding' && provider.type !== 'llm') return unavailable()
  if (protocol === 'responses' && provider.supports_responses !== 1) return unavailable()

  // alias 优先：客户端只感知对外 id；未配置 alias 的行回退到原始 model 匹配
  const registered = await db.get<{ enabled: number; model: string }>(
    `SELECT enabled, model FROM models
     WHERE provider_id = ? AND (alias = ? OR (alias = '' AND model = ?))`,
    provider.id,
    model,
    model,
  )
  if (!registered || registered.enabled !== 1) return unavailable()

  const route = await db.get<{ enabled: number; max_concurrency: number }>(
    `SELECT enabled, max_concurrency FROM model_routes WHERE provider_id = ? AND model = ?`,
    provider.id,
    model,
  )
  if (route && route.enabled !== 1) return unavailable()

  return {
    matched: true,
    model,
    provider: {
      ...provider,
      route_max_concurrency: route?.max_concurrency ?? 0,
      upstream_model: registered.model,
    },
  }
}

/**
 * 解析模型对应的可用 provider 列表（enabled=1，按优先级升序）。
 * 优先查 model_routes（人工配置的路由）；该模型无路由配置时回退
 * models 表（自动发现/手动录入）中 enabled 的 provider；均无 → []。
 * 已有路由配置但全部 disabled 时不回退（用户显式关闭了所有开关）。
 */
export async function resolveRoute(db: Db, model: string): Promise<RoutedProvider[]> {
  const routed = await db.all<RoutedProvider & { priority: number }>(
    `SELECT p.*, r.priority, r.max_concurrency AS route_max_concurrency,
            COALESCE(m.model, r.model) AS upstream_model
     FROM model_routes r
     JOIN providers p ON p.id = r.provider_id
     LEFT JOIN models m ON m.provider_id = r.provider_id AND m.alias = r.model AND m.alias != ''
     WHERE r.model = ? AND r.enabled = 1 AND p.enabled = 1
     ORDER BY r.priority ASC, p.id ASC`,
    model,
  )
  if (routed.length > 0) return routed
  // 该模型已有路由行（哪怕全部关闭）→ 不启用 models 表回退
  const configured = await db.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM model_routes WHERE model = ?`,
    model,
  )
  if ((configured?.c ?? 0) > 0) return []
  return db.all<RoutedProvider>(
    `SELECT p.*, 0 AS route_max_concurrency,
            m.model AS upstream_model
     FROM models m
     JOIN providers p ON p.id = m.provider_id
     WHERE (m.alias = ? OR (m.alias = '' AND m.model = ?)) AND m.enabled = 1 AND p.enabled = 1
     ORDER BY p.id ASC`,
    model,
    model,
  )
}
