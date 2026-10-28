# lite-ai-gateway

`lite-ai-gateway` 是一个轻量级的 AI 网关，统一转发 OpenAI 兼容的 LLM 请求并聚合 MCP 请求，按「模型 + 供应商」计价，逐请求记录 token 用量与成本。

LLM 请求按模型维护的多供应商优先级路由转发，支持故障转移、会话亲和性、并发与超时控制；MCP 端点把多台上游 server 聚合成 streamable-HTTP 或 SSE，并按分组暴露白名单能力。供应商、模型、价格、API 密钥和分组都在后台维护，日志也在后台查看。

## 部署与运维

### 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `ADMIN_TOKEN` | 是 | 无 | 后台登录密钥 |
| `DATABASE_PATH` | | `./data/gateway.db` | Node 端 SQLite 路径 |
| `PORT` | | `8788` | Node 端监听端口 |

`.env` 由 `process.loadEnvFile()` 从当前工作目录加载，缺失时静默忽略。`DATABASE_PATH` 和 `PORT` 只对 Node 有效，Workers 只读 `ADMIN_TOKEN`。

### Node 生产运行

```bash
pnpm install
pnpm build             # vite build → dist/
pnpm start             # 托管 dist/ + API，默认 8788
```

空库首次启动会自动执行 `schema.sql`，数据库默认落在 `./data/gateway.db`。打开 http://localhost:8788，用 `ADMIN_TOKEN` 登录后台。

### Docker 自部署

构建阶段用 Node 26 和 pnpm 编译前端，再用 `pnpm build:server --no-exe` 把后端及依赖打成单个 `node.mjs`，不生成 SEA。运行阶段基于 `gcr.io/distroless/nodejs26-debian13:nonroot`，只复制 `server/node.mjs`、同目录的 `schema.sql` 和 `dist/`，不含后端源码和 `node_modules`。

```bash
cp .env.example .env   # 至少填入 ADMIN_TOKEN
docker compose up -d --build
```

| 项 | 值 |
|---|---|
| 端口 | 容器内 `8788`，映射到宿主 `8788:8788` |
| 数据 | 命名卷 `gateway-data` 挂载到 `/app/data`，`DATABASE_PATH=/app/data/gateway.db` |
| 配置 | 从同目录 `.env` 插值 `ADMIN_TOKEN`，与 `pnpm dev` 共用一份 |
| 运行用户 | 非 root，UID/GID `1000:1000` |
| 镜像源 | 默认 `docker.1ms.run` + npmmirror；用官方源加 `--build-arg NODE_IMAGE=node:26-trixie-slim --build-arg NPM_REGISTRY=https://registry.npmjs.org`，运行镜像可用 `--build-arg RUNTIME_IMAGE=...` 换成其他 Distroless Node.js 26 镜像 |

不用 compose 时直接执行 `docker build -t lite-ai-gateway . && docker run -d -p 8788:8788 -e ADMIN_TOKEN=xxx -v gateway-data:/app/data lite-ai-gateway`。改用绑定挂载 `./data:/app/data` 时，宿主目录属主必须是 UID 1000，否则 SQLite 写不进去。只跑 LLM 中转时，把 compose 的 `ports` 改成 `127.0.0.1:8788:8788`。

### Cloudflare Workers

`wrangler.jsonc` 已配好 D1 绑定（`database_name: lite-ai-gateway`）和 `secrets.required: ["ADMIN_TOKEN"]`。部署前先做两件事。

1. 用 `pnpm exec wrangler secret put ADMIN_TOKEN` 设置令牌。配置里没有 `vars`，它只能以 secret 形式提供；首次部署时 Worker 还不存在，`secret put` 可能报错，可以先让一次部署失败，或改用 `wrangler deploy --secrets-file`。
2. 新库执行 `pnpm db:init:remote` 应用 `schema.sql`；既有库按上面的「既有数据库升级」建表，不重放完整 schema。

```bash
pnpm deploy             # vite build && wrangler deploy
```

`wrangler deploy` 会校验 `secrets.required`，缺失时直接失败并列出缺失的 key。

本地调试必须先 `pnpm build`，`assets.directory` 指向 `./dist`，缺失时 `wrangler dev` 会报错。

```bash
pnpm build
cp .env.example .dev.vars   # 本地 secret 放这里，只加载 secrets.required 列出的键
pnpm db:init:local          # 本地 D1，默认持久化到 .wrangler/state
pnpm dev:cf
```

改动 D1 绑定后运行 `wrangler types` 重新生成 `worker-configuration.d.ts`。

Workers 上有两处限制：`stdio` 和 `sse` 类型的 MCP 上游只能在 Node 上跑，在 Workers 上直接报错；SSE 入站的会话注册表在单个 isolate 的内存里，isolate 回收或发版后旧会话即断。

### 预构建产物

推送 `v*` tag 触发 `.github/workflows/release.yml`，Docker 镜像与可执行文件两个 job 并行执行，不创建 GitHub Release。

镜像只构建 `linux/amd64`，推送至 `ghcr.io/ravizhan/lite-ai-gateway`，标签为 tag 名（保留 `v` 前缀）和 `latest`。构建阶段用官方 `node:26-trixie-slim` 和 npm 官方源，运行阶段用 `gcr.io/distroless/nodejs26-debian13:nonroot`，推送凭据为 `GITHUB_TOKEN`。`latest` 随每个 `v*` tag 更新，测试和预发布 tag 同样会覆盖它。

```bash
docker pull ghcr.io/ravizhan/lite-ai-gateway:latest
docker run -d -p 8788:8788 -e ADMIN_TOKEN=xxx -v gateway-data:/app/data ghcr.io/ravizhan/lite-ai-gateway:latest
```

可执行文件在 Ubuntu 上构建（Node 26 + pnpm 12.3.4），先通过 `pnpm typecheck && pnpm lint && pnpm build`，再由 `pnpm build:server`（tsdown + Node SEA）生成三个平台的产物，上传为 artifact `lite-ai-gateway-exe-${tag}`。

| 压缩包 | 目标平台 |
|---|---|
| `lite-ai-gateway-linux-x64.tar.gz` | Linux x64 |
| `lite-ai-gateway-win-x64.exe.tar.gz` | Windows x64 |
| `lite-ai-gateway-darwin-arm64.tar.gz` | macOS arm64 |

压缩包为扁平结构，根目录直接放可执行文件、`schema.sql` 和前端 `dist/`；`dist-bundle/server/node.mjs` 等中间产物不随 artifact 发布。

```bash
mkdir gateway && tar -xzf lite-ai-gateway-linux-x64.tar.gz -C gateway
cd gateway
chmod +x lite-ai-gateway-linux-x64
./lite-ai-gateway-linux-x64          # 默认监听 8788
```

`.env` 和默认 SQLite 路径（`./data/gateway.db`）相对当前工作目录，需在解压目录内运行或显式设置 `DATABASE_PATH`；压缩包不含 `.env`，需自行创建并至少填写 `ADMIN_TOKEN`。可执行文件自带 Node 运行时，网关本体无需预装 Node，但 `stdio` 类型 MCP 上游是外部命令，其运行时需另行安装。

## 开发说明

### 本地开发

需要 Node ≥ 24（CI 基线版本；最低可运行 22.18，只要支持原生 TS 类型剥离）和 pnpm。

```bash
pnpm install
cp .env.example .env   # 填入 ADMIN_TOKEN；可选 DATABASE_PATH / PORT
pnpm dev               # Vite(5173) + API(8788)
```

打开 http://localhost:5173，用 `.env` 里的 `ADMIN_TOKEN` 登录后台。空库自动执行 `schema.sql`，数据库默认落在 `./data/gateway.db`。

### 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 并行启动 Vite(5173) + `node --watch` API(8788) |
| `pnpm dev:cf` | `wrangler dev`，需先 `pnpm build` |
| `pnpm build` | `vite build` → `dist/` |
| `pnpm build:server` | `tsdown` 把 `server/node.ts` 打成单文件，并生成 linux-x64 / win-x64 / darwin-arm64 三个 SEA 可执行文件到 `dist-bundle/server/` |
| `pnpm start` | Node 生产运行 |
| `pnpm deploy` | `vite build && wrangler deploy` |
| `pnpm db:init:local` / `db:init:remote` | 向本地/远程 D1 应用 `server/db/schema.sql` |
| `pnpm typecheck` | `vue-tsc`（前端）+ `tsc`（server） |
| `pnpm lint` | ESLint（`lint:fix` 自动修复） |

质量门禁是 `pnpm typecheck && pnpm lint && pnpm build`。CI 在 `main` push 和所有 PR 上以 Node 24 + pnpm 12.3.4 依次执行 `pnpm install --frozen-lockfile`、typecheck、lint、build。Node 端 TS 以原生类型剥离运行，没有构建步骤。Vite dev 代理把 `/v1`、`/api`、`/mcp`、`/sse`、`/messages` 转发到 8788，其中 `/mcp` 带 `Accept: text/html` 的导航请求交回 SPA。

### 目录结构

```
server/                  h3 后端（双运行时共享）
  app.ts                 中间件挂载 + 路由注册（唯一组装点）
  auth.ts                requireAdmin / requireApiKey
  node.ts / cloudflare.ts  运行时入口（env、DB 注入、SPA 托管 / serve）
  admin/                 管理 CRUD：providers models prices routes keys logs stats info mcp settings
  llm/                   relay、router、session-affinity、concurrency、usage、sse-tap、responses-usage、embed
  mcp/                   hub 聚合、upstream 客户端、streamable-HTTP + SSE（node/workers 两变体）
  db/                    Db 接口 + node:sqlite / D1 适配器 + schema.sql
  lib/                   sanitize、keys、timeout、version、transform（QuickJS）
src/                     Vue 3 SPA（pages/ components/ layouts/ lib/ stores/ locales/ router/）
shared/                  前后端共享行类型、gatewayError() 工厂、MCP 命名规则
data/                    本地 SQLite 状态（gitignored）
```

### 本地构建可执行文件

要求 Node ≥ 25.7.0（tsdown 的 SEA 校验下限），推荐与发布一致的 Node 26。SEA blob 必须与目标可执行文件使用同一个 Node 版本，版本取自本机 `process.versions.node`，构建时会从 nodejs.org 下载各平台 Node 二进制做模板。产物是 `dist-bundle/server/` 下的可执行文件和中间文件 `node.mjs`，后者不参与发布；可执行文件在自身目录里查找 `schema.sql` 与 `dist/`，所以要按压缩包的扁平结构补齐资源。

```bash
pnpm build && pnpm build:server
mkdir -p pkg
cp dist-bundle/server/lite-ai-gateway-linux-x64 server/db/schema.sql pkg/
cp -r dist pkg/dist
cd pkg && ./lite-ai-gateway-linux-x64
```

## 技术说明

后端是 h3 加 SQLite/D1，前端是 Vue 3、Vite 8、@nuxt/ui v4、vue-i18n（en/zh-CN）和 ECharts，embedding 变换沙箱用 `@cf-wasm/quickjs`，schema 和类型契约放在 `shared/` 里供前后端共用。

### LLM 中转

所有 `/v1` 端点都用 `api_keys` 表里的密钥认证，密钥在后台「API 密钥」页创建。供应商分 `llm` 和 `embedding` 两类，可随时启停，也能用 `/models` 把上游模型一键登记进来。

```bash
curl http://localhost:8788/v1/chat/completions \
  -H "Authorization: Bearer sk-xxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5",
    "messages": [{ "role": "user", "content": "你好" }],
    "stream": true
  }'
```

| 端点 | 说明 |
|---|---|
| `POST /v1/chat/completions` | Chat Completions 中转，流式/非流式 |
| `POST /v1/responses` | Responses API 中转，仅 `supports_responses=1` 的供应商 |
| `POST /v1/embeddings` | Embedding 中转，可带 transform；路由不强制校验供应商类型 |
| `GET /v1/models` | `model_routes` 中出现过的模型（含 disabled 路由）加 `models` 表中 enabled 的模型 |

Chat Completions 流式请求需带 `stream_options.include_usage: true`，网关从响应尾部读取 usage。Responses 无需这个参数，网关增量提取 `response.completed`、`response.incomplete` 或 `response.failed` 中的 `response.usage`，不缓存完整输出，也不受结束事件大小超过 64 KiB 的限制。两种协议都原样透传响应字节；上游没有返回 usage 时，token 用量和成本记为 0。

#### 路由与回退

路由按 `model` 维护一份有序的供应商优先级列表。模型没有显式路由时，网关回退到所有 enabled 的模型，任何启用的供应商都能接。

但 `model_routes` 里存在这个模型的行时，哪怕那些行全是 disabled，也不再回退，直接返回 404。

#### 指定供应商

把 `model` 写成「供应商名称/模型名称」，请求就跳过路由，锁定这家供应商，上游 `model` 改写成后面的模型名。这次请求跳过亲和性和优先级，失败不切换供应商；供应商、已登记模型和对应的路由仍须启用，协议支持和并发上限照常生效。

```json
{
  "model": "供应商A/gpt-5",
  "messages": [{ "role": "user", "content": "你好" }]
}
```

前缀匹配扫描全部供应商（含 disabled），所以名为 `org` 的禁用供应商会把 `org/model` 变成 404，而不是按完整模型名继续路由。前缀后的模型名必须是对外 ID，配了 alias 的只按 alias 命中。供应商名称本身含 `/` 时匹配最长的配置名称；模型名也可以含 `/`，`供应商A/org/model` 会转发为 `org/model`。

#### 计费

价格按「对外模型名 `model` + 供应商 `provider_id`」独立配置，单位美元 / 1M tokens。对外模型名优先取 alias，没设则用原始模型名，指定供应商请求里的前缀不算模型名。embedding 只记录 token 用量，成本恒为 0，不读价格表。后台「模型与价格 → 定价」可按模型比较各家报价，未配置与明确设为 0 是两种状态；没有对应组合价格的请求成本计 0，不回退到其他供应商的价格。

```
成本 = ((prompt − cached) × input_price + cached × cache_read_price + completion × output_price) / 1,000,000
```

用量归一化覆盖 chat、responses 和 embeddings，兼容 `prompt_tokens_details.cached_tokens`、DeepSeek 的 `prompt_cache_hit_tokens`、Responses 的 `input_tokens_details` 和 Cohere 的 `meta.billed_units`。流式请求的 usage 从响应尾部解析，连同 TTFT、TPS 和时长一起计入成本。

chat 和 responses（含流式）用实际响应那家供应商的价格，故障转移后用接替者的价格。价格在请求完成时读取，成本写入日志后不随改价重算，日志详情展示记录值。修改模型 alias 会改变定价身份，需要为新名称重新配置价格。

只有真正尝试过供应商的请求才写 `llm_logs`；读请求体失败、JSON 不合法、缺 `model`、找不到可用供应商这些在路由阶段被拒绝的请求不落日志。

流式响应被客户端取消或上游中断后，网关结束收尾、释放并发租约并写入日志，不切换供应商。SSE 断流记录 `error = 'upstream stream interrupted'`，用量和成本记为 0；同时丢失租约时优先记录租约错误。`status` 保留上游已返回的 HTTP 状态，可能仍是 200，需结合 `error` 判断请求是否完整结束。4xx 响应在捕获过程中中断时保留请求正文和上游错误状态，`resp_body` 为 NULL，不把部分响应记成完整正文。

#### 超时与并发

`timeout_ms` 只对非流式 chat/responses、embedding 和模型发现/测试生效。流式 chat/responses 不套上游超时，卡住的长流不会被中止，也不会因此切换供应商。

在途并发用租约控制，TTL 10 分钟，每 3 分钟续租，租约存在数据库里，跨进程也安全。供应商级和路由级（model/provider 组合）两个限额都为 0 时不启用租约。chat/responses 并发满时不排队，逐个尝试候选供应商，全满返回 429；embedding 最多排队 5 秒；租约丢失返回 503。被会话亲和性粘住的供应商并发满时立即返回 429，出现可重试失败（网络错误或 5xx）则作废这次绑定，后续请求重新按优先级选择。

#### Embedding 变换

供应商级的 `transform_code` 在 QuickJS 沙箱里改写 embedding 请求体和响应体。限制为 interrupt 回调计数预算 10,000,000、内存 32 MiB、栈 1 MiB、输入 8 MiB、输出 16 MiB，回调预算不是精确的 JavaScript 指令数。转换必须同步返回 JSON，Promise 等 thenable 返回值会报错。保存时仍用 `{ text: 'probe', index: 0 }` 探针校验。

### MCP 接入

MCP 端点与 LLM 共用 `api_keys` 认证，没有独立的 MCP key。上游 server 有三种类型：`stdio` 和 `sse` 客户端仅 Node 可用，`streamable-http` 两个运行时都支持。

| 端点 | 说明 |
|---|---|
| `/mcp`（POST/GET/DELETE） | streamable-HTTP，不带组等于聚合全部 enabled servers 的 default 组 |
| `/mcp/:group` | streamable-HTTP，按命名组暴露白名单内能力 |
| `/sse`、`/sse/:group` | 兼容 SSE 传输，随后用 `POST /messages?sessionId=` 发消息 |

`/mcp` 每请求无状态，没有会话 ID；`GET /mcp` 不带 `Accept: text/event-stream` 返回 406。SSE 会话注册表在单进程或单 isolate 的内存里，进程重启、isolate 回收后旧会话即断。

#### 聚合规则

工具默认用原始名称，只有同一组内实际暴露的名称冲突时，才给冲突双方加 `${serverName}__` 前缀：两台服务器都有 `search` 时暴露为 `alpha__search` 和 `beta__search`，组内只选一台则仍是 `search`。原生名和生成的前缀名再冲突时继续叠加前缀。prompts 始终带 `${serverName}__${name}` 前缀，resources 不带前缀，按第一个提供该 URI 的 server 路由。

`tools/list` 和 `tools/call` 共用这套映射，支持分页和未经 list 的直接调用，无冲突工具不保留旧的前缀别名。组内工具发现失败时两者都返回错误，不按残缺列表重新分配名称，避免误调另一台服务器的工具；不提供 tools 能力的服务器不算发现失败。已开启的本地 `web_search` 可直接调用，不依赖普通工具库存。

分组只暴露勾选过的白名单；空上游白名单不暴露普通能力，但可以单独开启本地 `web_search`。default 组不过滤普通上游，也不会自动加入搜索工具。server 创建或启用时自动发现能力并持久化快照，供分组选择界面使用；`POST /api/admin/mcp/reload` 清空上游连接缓存。

#### 内置 `web_search`

搜索聚合复用已有 MCP 服务器、传输和凭据。绑定由「服务器 + 原始工具名」唯一确定，所有命名组共用一个搜索池；开启后固定名称 `web_search` 指向本地工具，同名普通工具按服务器前缀规则改名。修改分组后客户端应刷新工具列表。

在后台「搜索聚合」（`/mcps/search`）添加绑定并填写请求、响应两段转换代码，预置覆盖 Tavily（`tavily_search`）、Exa Advanced（`web_search_advanced_exa`）和 Firecrawl（`firecrawl_search`）；随后在「分组」勾选本地搜索工具并保存，复制该组的 MCP 地址。管理 API 位于 `/api/admin/mcp/search`。

每次调用从已启用绑定的候选中等概率选一行，最多执行一次上游 `tools/call`，不做重试、故障切换或多源合并；Workers 候选仅含 `streamable-http`。请求转换、连接、调用和响应转换共用 60 秒截止，调用者取消会终止当前调用。空池仍列出工具，调用返回 `web_search: no eligible upstream`。

统一输入为 `query`、`max_results`（1–20 的整数，默认 10）和可选 `objective`，`query` 去除首尾空白后须为 1–400 字符；输出为 `{ results: [...] }`，每项含 HTTP(S) `url`、可空 `content` 与可选 `title`、`published_at`。转换脚本为 `({ request }) => upstreamArguments` 与 `({ request, response }) => ({ results })`，只能转换数据，不能选服务器、工具或请求头，也不能访问网络、宿主函数和数据库；上游 `isError` 直接作为工具错误返回。

#### MCP 日志

经过认证进入 MCP 传输层的请求都会记录，包括 initialize、ping、工具调用、提示词、资源读取、通知，以及无效请求和传输层拒绝；各类 `*/list` 能力列表请求和 `notifications/initialized` 通知不记录。`request_body` 保存请求原文，`response_body` 保存发给客户端的完整响应（成功和失败都记录），JSON-RPC error 和 `isError: true` 的工具结果记为失败。取消或断连且无响应时保留输入并记失败，`response_body` 为 NULL。每个客户端请求记一条 `direction='call'` 日志，内部上游发现失败另记一条 `direction='upstream'`。

错误摘要会脱敏，但原始请求和响应可能含敏感数据，数据库和管理端的访问权限需自行控制。

## 许可证

[AGPL-3.0](LICENSE)
