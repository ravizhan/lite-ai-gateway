-- lite-ai-gateway 数据库结构（Node SQLite 与 Workers D1 共用同一份，幂等可重复执行）
-- 建表方式：
--   Node: 启动时检查库是否为空（sqlite_master 无用户表），为空则执行本文件；非空则跳过。
--   D1:   pnpm db:init:local | db:init:remote（wrangler d1 execute --file=server/db/schema.sql）
-- 不做增量迁移：schema 变更由本文件手工修改 + 手动对存量库执行 ALTER / 重建。
-- 存量库升级顺序（必须先 ALTER 再执行本文件）：SQLite 在 CREATE TRIGGER 时不解析触发器体内
-- 的列名，缺 cost_pending 时触发器仍会创建成功，直到首次写 prices 才报 "no such column"。
--   ALTER TABLE llm_logs ADD COLUMN cost_pending INTEGER NOT NULL DEFAULT 0;
-- 之后执行本文件创建回填触发器。存量行默认 cost_pending = 0，视为已冻结、永不重算。
-- 缺 MCP 日志正文列的存量库另需：
--   ALTER TABLE mcp_logs ADD COLUMN request_body TEXT;
--   ALTER TABLE mcp_logs ADD COLUMN response_body TEXT;

CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'llm' CHECK (type IN ('llm', 'embedding')), -- provider protocol
  enabled INTEGER NOT NULL DEFAULT 1,
  supports_responses INTEGER NOT NULL DEFAULT 0, -- 仅 llm 类型生效
  timeout_ms INTEGER NOT NULL DEFAULT 0, -- 上游超时；0=不限；仅非流式/发现/测试生效
  max_concurrency INTEGER NOT NULL DEFAULT 0, -- 跨该提供商全部模型的总在途上限；0=无限
  transform_code TEXT NOT NULL DEFAULT '', -- 仅 embedding 类型生效；空 = 纯透传
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  alias TEXT NOT NULL DEFAULT '', -- 对外模型 id（客户端请求/计费/路由/日志统一使用）；空 = 用原始 model
  discovered INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(provider_id, model)
);

CREATE TABLE IF NOT EXISTS prices (
  model TEXT NOT NULL,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  input_price REAL NOT NULL DEFAULT 0,
  output_price REAL NOT NULL DEFAULT 0,
  cache_read_price REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (model, provider_id)
);

CREATE TABLE IF NOT EXISTS model_routes (
  model TEXT NOT NULL,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  max_concurrency INTEGER NOT NULL DEFAULT 0, -- 该 model/provider 组合的在途上限；0=无限
  PRIMARY KEY (model, provider_id)
);

-- 供应商在途并发租约（provider/route limit 任一非零时每受限请求一条）。
-- 不建二级索引：峰值约 10 并发，表内正常只有个位数活跃行；WITHOUT ROWID 避免 TEXT
-- 主键另建 autoindex（二级索引会让每次 INSERT/DELETE 额外计入 index-row writes）。
CREATE TABLE IF NOT EXISTS llm_concurrency_leases (
  lease_id TEXT PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;

-- session → provider 粘性绑定（sticky 请求每请求一次 UPSERT claim）。
-- 不建 expiry 索引：复合主键覆盖每请求的精确查询且不产生独立 autoindex；过期 row 对
-- 查询不可见，同一 scope 下次 claim 原位覆盖，请求路径不做全表清理。
CREATE TABLE IF NOT EXISTS llm_session_affinity (
  api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL,
  model TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  binding_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (api_key_id, protocol, model, session_hash)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS llm_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  api_key_id INTEGER,
  protocol TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_id INTEGER,
  provider_name TEXT,
  stream INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  ttft_ms INTEGER,
  duration_ms INTEGER NOT NULL,
  tps REAL,
  cost REAL NOT NULL DEFAULT 0,
  -- 计费在落库时冻结：cost 只由本次 INSERT（或首次配置价格的回填）写入，之后改价、
  -- 删除/重建模型、删除后重新添加价格都不再改动它（0 也可能是有效定价）。
  -- cost_pending: 0 = 已定价（cost 为最终值）；1 = 落库时 prices 无该 (model, provider_id)
  -- 行，cost 暂为 0，等该组合首次插入价格行时回填。embedding 不计费，恒为 0。
  cost_pending INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  client_ip TEXT,
  req_body TEXT, -- 仅错误请求（最终状态非 200）记录完整请求体；正常请求为 NULL
  resp_body TEXT -- 仅错误请求记录完整响应体（流式为拼接后的全部 chunk）；正常请求为 NULL
);

CREATE INDEX IF NOT EXISTS idx_llm_logs_ts ON llm_logs(ts);

-- 首次配置价格（prices INSERT，含 upsert 的插入分支）时，回填此前因无价格而挂起的日志。
-- 只处理 cost_pending = 1 的 chat/responses 行：已冻结的历史行（含 0 价、embedding）不动；
-- 改价是 prices UPDATE，不触发本触发器 → 历史日志成本不变。
-- 竞态：日志 INSERT 用单条 INSERT..SELECT LEFT JOIN prices 在同一语句内决定 cost 与
-- cost_pending；SQLite 单写者串行化，保证「先落库后配价」与「先配价后落库」都只计一次。
DROP TRIGGER IF EXISTS trg_prices_insert_backfill_logs;
CREATE TRIGGER trg_prices_insert_backfill_logs
AFTER INSERT ON prices
FOR EACH ROW
BEGIN
  UPDATE llm_logs
     SET cost = (
           (prompt_tokens - cached_tokens) * NEW.input_price
           + cached_tokens * NEW.cache_read_price
           + completion_tokens * NEW.output_price
         ) / 1000000.0,
         cost_pending = 0
   WHERE cost_pending = 1
     AND protocol IN ('chat', 'responses')
     AND model = NEW.model
     AND provider_id = NEW.provider_id;
END;

CREATE TABLE IF NOT EXISTS mcp_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  command TEXT,
  args TEXT,
  env TEXT,
  url TEXT,
  headers TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS mcp_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT ''
);

-- MCP 能力快照：server 创建时发现并持久化（无论 enabled）；detail 为能力完整 JSON
-- （tool/prompt 原样，resource 的 name = uri）。禁用后保留快照，重新启用时全量替换。
CREATE TABLE IF NOT EXISTS mcp_capabilities (
  server_id INTEGER NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  detail TEXT NOT NULL,
  PRIMARY KEY (server_id, kind, name)
);

-- 分组能力白名单：空/缺省 = 该 server 没有任何能力被暴露（不是整 server 放行）。
-- 不引用 mcp_capabilities 外键：重新发现时快照先删后插，级联会误删选择。
CREATE TABLE IF NOT EXISTS mcp_group_capabilities (
  group_id INTEGER NOT NULL REFERENCES mcp_groups(id) ON DELETE CASCADE,
  server_id INTEGER NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (group_id, server_id, kind, name)
);

-- 能力 prompt 覆盖：管理端编辑的描述文本，hub 聚合 tools/prompts/resources/list 时替换
-- 快照中的默认 description。不引用 mcp_capabilities 外键：重新发现时快照先删后插，
-- 级联会误删覆盖；失效覆盖（能力已消失）保留但永不匹配，无副作用。
CREATE TABLE IF NOT EXISTS mcp_prompt_overrides (
  server_id INTEGER NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (server_id, kind, name)
);

-- 内置 web_search 上游绑定：身份 (server_id, tool_name)，每次调用按绑定行等概率抽一家。
-- request_code/response_code 是用户可编辑的 QuickJS 转换；preset_id/preset_version 只记录
-- 来源，运行时只读绑定行代码。不写 mcp_capabilities、不伪造 mcp_servers 行。
CREATE TABLE IF NOT EXISTS mcp_search_upstreams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  request_code TEXT NOT NULL,
  response_code TEXT NOT NULL,
  preset_id TEXT,
  preset_version INTEGER,
  UNIQUE (server_id, tool_name),
  CHECK ((preset_id IS NULL AND preset_version IS NULL)
    OR (preset_id IS NOT NULL AND preset_version IS NOT NULL AND preset_version > 0))
);

-- 分组本地 web_search 开关：有行 = 开启，无行 = 关闭。
CREATE TABLE IF NOT EXISTS mcp_group_web_search (
  group_id INTEGER PRIMARY KEY REFERENCES mcp_groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mcp_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  direction TEXT NOT NULL, -- 'call' = 客户端协议请求/通知；'upstream' = hub 聚合时的内部上游调用
  group_name TEXT,
  server_name TEXT,
  method TEXT NOT NULL,
  tool_name TEXT,
  duration_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT,
  request_body TEXT, -- 入站 JSON-RPC 消息原文（请求/通知；协议层前被拒的请求为原始 HTTP 请求体）；内部上游行为合成请求
  response_body TEXT -- 发给客户端的完整 JSON-RPC 响应原文（成功与失败均记录）；通知或无响应为 NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_logs_ts ON mcp_logs(ts);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
