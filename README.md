# lite-ai-gateway

## 项目介绍

`lite-ai-gateway` 是一个轻量级的 AI 网关，统一转发 OpenAI 兼容的 LLM 请求和 MCP 请求，并记录用量与成本。同一套代码可以跑在两种运行时上：Node（`node:sqlite`）和 Cloudflare Workers（D1），外加一个单租户的 Vue 3 管理后台。

主要能力：

- LLM 中转：`/v1/chat/completions`、`/v1/responses`、`/v1/embeddings`，按模型维护多供应商优先级路由，支持故障转移、会话亲和性、并发与超时控制。
- 计费：按「模型 + 供应商」配置价格，归一化多种上游的 usage 形态，逐请求记录 token 用量、TTFT、TPS 与成本。
- MCP 聚合：把多台上游 MCP server 聚合到一个 streamable-HTTP 或 SSE 端点，按分组暴露白名单能力，工具名冲突时自动加前缀。
- 管理后台：维护供应商、模型、价格、路由、API 密钥和 MCP 分组，查看 LLM 与 MCP 日志。

## 部署与运维

### 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `ADMIN_TOKEN` | 是 | 无 | 后台登录密钥 |
| `DATABASE_PATH` | | `./data/gateway.db` | Node 端 SQLite 路径 |
| `PORT` | | `8788` | Node 端监听端口 |

`.env` 由 `process.loadEnvFile()` 从当前工作目录加载，文件缺失时静默忽略。`DATABASE_PATH` 和 `PORT` 只对 Node 运行时有效，Workers 运行时只读 `ADMIN_TOKEN`。

### Node 生产运行

按生产模式运行时，先构建前端再启动后端。

```bash
pnpm install
pnpm build             # vite build → dist/
pnpm start             # node server/node.ts：托管 dist/ + API，默认 8788
```

首次启动检测到空库会自动执行 `schema.sql`，数据库默认落在 `./data/gateway.db`。打开 http://localhost:8788，用 `ADMIN_TOKEN` 登录管理后台。

### Docker 自部署

构建阶段使用 Node.js 26 和 pnpm，通过 `pnpm build` 编译前端，再用 `pnpm build:server --no-exe` 将后端及其依赖打包为单个 `node.mjs`，不生成 SEA 可执行文件。运行阶段基于 `gcr.io/distroless/nodejs26-debian13:nonroot`，只复制 `/app/server/node.mjs`、同目录的 `schema.sql` 和 `/app/dist/`，不包含后端源码或 `node_modules`。Distroless 的 Node 入口直接运行 `server/node.mjs`，同时托管前端和 API。

```bash
cp .env.example .env   # 至少填入 ADMIN_TOKEN
docker compose up -d --build
```

打开 http://localhost:8788，用 `.env` 里的 `ADMIN_TOKEN` 登录。首次启动检测到空库同样会自动执行 `schema.sql`。

| 项 | 值 |
|---|---|
| 端口 | 容器内 `8788`，compose 映射到宿主 `8788:8788` |
| 数据 | 命名卷 `gateway-data` 挂载到 `/app/data`，`DATABASE_PATH=/app/data/gateway.db` |
| 配置 | `docker-compose.yml` 从同目录 `.env` 插值 `ADMIN_TOKEN`（与 `pnpm dev` 共用一份 `.env`） |
| 运行用户 | 非 root（数字 UID/GID `1000:1000`），兼容原镜像的数据卷属主 |
| 镜像源 | 构建阶段默认使用 `docker.1ms.run` + npmmirror；要用官方源，加 `--build-arg NODE_IMAGE=node:26-trixie-slim --build-arg NPM_REGISTRY=https://registry.npmjs.org`。运行阶段默认使用 GCR 上的 Distroless，可通过 `--build-arg RUNTIME_IMAGE=...` 指定兼容的 Distroless Node.js 26 镜像源 |

有几处需要留意。不用 compose 时，可以直接执行 `docker build -t lite-ai-gateway . && docker run -d -p 8788:8788 -e ADMIN_TOKEN=xxx -v gateway-data:/app/data lite-ai-gateway`。改用绑定挂载（`./data:/app/data`）时，宿主目录属主必须是 UID 1000，否则 SQLite 写不进去。只跑 LLM 中转时，可以把 compose 的 `ports` 改成 `127.0.0.1:8788:8788`，仅本机或反向代理可达。

### Cloudflare Workers

`wrangler.jsonc` 里已经配好 D1 绑定（`database_name: lite-ai-gateway`）和 `secrets.required: ["ADMIN_TOKEN"]`。部署前需要先完成两件事。

1. 用 `pnpm exec wrangler secret put ADMIN_TOKEN` 设置远程管理令牌。`wrangler.jsonc` 里没有 `vars`，`ADMIN_TOKEN` 只能以 secret 形式提供。首次部署时 Worker 还不存在，`secret put` 可能报错，可以先让一次部署失败再设置，或者改用 `wrangler deploy --secrets-file`。
2. 执行 `pnpm db:init:remote`，把 `schema.sql` 应用到远程 D1。

配好之后执行部署命令。

```bash
pnpm deploy             # vite build && wrangler deploy（静态资源走 Workers Assets）
```

`wrangler deploy` 会校验 `secrets.required` 里的 secret 是否都已配置，缺失时直接失败并列出缺失的 key。

本地调试 Workers 运行时用下面几条命令。注意 `pnpm build` 必须先跑，`assets.directory` 指向 `./dist`，缺失时 `wrangler dev` 会报错。

```bash
pnpm build              # 产出 dist/
cp .env.example .dev.vars   # 本地 secret 放 .dev.vars（secrets.required 下只加载其中列出的键）
pnpm db:init:local      # 向本地 D1 应用 schema.sql（默认持久化到 .wrangler/state）
pnpm dev:cf             # wrangler dev
```

改动 D1 绑定后，运行 `wrangler types` 重新生成 `worker-configuration.d.ts`。

Workers 上有两处限制。`stdio` 和 `sse` 类型的 MCP 上游只能在 Node 运行时上用，在 Workers 上会直接报错。SSE 入站的会话注册表放在单个 isolate 的内存里，isolate 被回收或者发版之后，旧会话就断了。

### 预构建产物

推送 `v*` tag 会触发 `.github/workflows/release.yml`，两个 job 并行执行，不创建 GitHub Release。

Docker 镜像构建成 `linux/amd64` 并推送到 GHCR，镜像名 `ghcr.io/ravizhan/lite-ai-gateway`，标签是 tag 名（保留 `v` 前缀）和 `latest`。发布镜像使用官方 `node:26-trixie-slim` 和 npm 官方源构建，运行阶段使用 `gcr.io/distroless/nodejs26-debian13:nonroot`，推送凭据用 `GITHUB_TOKEN`。

```bash
docker pull ghcr.io/ravizhan/lite-ai-gateway:latest
docker run -d -p 8788:8788 -e ADMIN_TOKEN=xxx -v gateway-data:/app/data ghcr.io/ravizhan/lite-ai-gateway:latest
```

`latest` 在每个 `v*` tag 上都会更新，测试和预发布 tag 同样会覆盖它，需要固定版本就用 tag 名那个标签。GHCR 包默认私有，要公开得去 GitHub 的包设置里手动改。镜像只构建 `linux/amd64`，不含其他架构。

可执行文件在 Ubuntu 上构建，环境是 Node 26 加 pnpm 12.3.4，先过一遍 `pnpm typecheck && pnpm lint && pnpm build`，再用 `pnpm build:server`（tsdown 打包 + Node SEA）生成三个平台的产物，上传为 artifact `lite-ai-gateway-exe-${tag}`，保留 30 天。

| 压缩包 | 目标平台 |
|---|---|
| `lite-ai-gateway-linux-x64.tar.gz` | Linux x64 |
| `lite-ai-gateway-win-x64.exe.tar.gz` | Windows x64 |
| `lite-ai-gateway-darwin-arm64.tar.gz` | macOS arm64 |

压缩包是扁平结构，根目录下直接放可执行文件、`schema.sql` 和前端 `dist/`，一个包里只有这一个可执行文件，`dist-bundle/server/node.mjs` 之类的中间产物不随 artifact 发布。解压后要进到解压目录里再启动。

```bash
mkdir gateway && tar -xzf lite-ai-gateway-linux-x64.tar.gz -C gateway
cd gateway
chmod +x lite-ai-gateway-linux-x64
./lite-ai-gateway-linux-x64          # 默认监听 8788
```

macOS 上要先 `chmod +x lite-ai-gateway-darwin-arm64`，再做一次 ad-hoc 签名 `codesign --force --sign - lite-ai-gateway-darwin-arm64`，否则会被 Gatekeeper 拦下。交叉构建在非 macOS 机器上没法签名，构建工具对 darwin 目标会自动尝试一次，失败仅告警，签名必须在目标 macOS 上做。Windows 上建议在 cmd 或 PowerShell 里运行 `lite-ai-gateway-win-x64.exe`，方便查看启动输出。

`.env` 和默认的 SQLite 路径（`./data/gateway.db`）都相对当前工作目录，所以要在解压目录里运行，或者显式设置 `DATABASE_PATH`；压缩包里不含 `.env`，需要自行创建，至少填上 `ADMIN_TOKEN`。可执行文件自带 Node 运行时，网关本体不需要预装 Node，但 `stdio` 类型的 MCP 上游仍然是外部命令，它的运行时得另外安装。

## 开发说明

### 本地开发

本地开发需要 Node ≥ 24（CI 基线版本；最低可运行版本为 22.18，只要支持原生 TS 类型剥离即可，后端源码不需要构建）和 pnpm。

```bash
pnpm install
cp .env.example .env   # 填入 ADMIN_TOKEN；可选 DATABASE_PATH / PORT
pnpm dev               # 同时启动 Vite(5173) + API 服务(8788)
```

打开 http://localhost:5173，用 `.env` 里的 `ADMIN_TOKEN` 登录管理后台。数据库默认落在 `./data/gateway.db`，空库自动执行 `schema.sql`。

### 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 并行启动 Vite(5173) + `node --watch` API(8788) |
| `pnpm dev:cf` | `wrangler dev`（Workers 运行时；需先 `pnpm build` 产出 `dist/`） |
| `pnpm build` | `vite build` → `dist/` |
| `pnpm build:server` | `tsdown` 把 `server/node.ts` 打成单文件，并生成 linux-x64 / win-x64 / darwin-arm64 三个 SEA 可执行文件到 `dist-bundle/server/` |
| `pnpm start` | Node 生产运行（托管 `dist/` + API） |
| `pnpm deploy` | `vite build && wrangler deploy` |
| `pnpm db:init:local` / `db:init:remote` | 向 D1（本地/远程）应用 `server/db/schema.sql` |
| `pnpm typecheck` | `vue-tsc`（前端）+ `tsc`（server） |
| `pnpm lint` | ESLint（`lint:fix` 自动修复） |

质量门禁是 `pnpm typecheck && pnpm lint && pnpm build`。`.github/workflows/ci.yml` 在 `main` 分支 push 和所有 PR 上依次执行 `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm lint`、`pnpm build`，环境为 Node 24 加 pnpm 12.3.4。Node 端的 TS 直接以原生类型剥离运行，没有构建步骤。Vite dev 代理把 `/v1`、`/api`、`/mcp`、`/sse`、`/messages` 转发到 8788，其中 `/mcp` 带 `Accept: text/html` 的文档导航请求交回 SPA。

### 目录结构

```
server/                  h3 后端（双运行时共享）
  app.ts                 中间件挂载 + 路由注册（唯一组装点）
  auth.ts                requireAdmin / requireApiKey
  node.ts / cloudflare.ts  运行时入口（env、DB 注入、SPA 托管 / serve）
  admin/                 管理 CRUD：providers models prices routes keys logs stats info mcp settings
  llm/                   relay、router、session-affinity、concurrency、usage、sse-tap、embed
  mcp/                   hub 聚合、upstream 客户端、streamable-HTTP + SSE（node/workers 两变体）
  db/                    Db 接口 + node:sqlite / D1 适配器 + schema.sql
  lib/                   sanitize、keys、timeout、version、transform（QuickJS）
src/                     Vue 3 SPA（pages/ components/ layouts/ lib/ stores/ locales/ router/）
shared/                  前后端共享行类型、gatewayError() 工厂、MCP 命名规则
data/                    本地 SQLite 状态（gitignored）
```

### 本地构建可执行文件

本地构建可执行文件要求 Node ≥ 25.7.0（tsdown 的 SEA 校验下限），推荐使用与发布一致的 Node 26。SEA blob 与目标可执行文件必须使用同一个 Node 版本，版本取自本机 `process.versions.node`，构建时会从 nodejs.org 下载各目标平台的 Node 二进制做模板（可以使用本机的 tsdown 缓存）。`pnpm build:server` 只产出 `dist-bundle/server/` 下的可执行文件与中间产物 `node.mjs`，`node.mjs` 不参与发布。本地运行前需要按压缩包同样的扁平结构补齐资源，先执行 `pnpm build` 生成 `dist/`，可执行文件在自身目录里查找 `schema.sql` 与 `dist/`。

```bash
pnpm build && pnpm build:server
mkdir -p pkg
cp dist-bundle/server/lite-ai-gateway-linux-x64 server/db/schema.sql pkg/
cp -r dist pkg/dist
cd pkg && ./lite-ai-gateway-linux-x64
```

## 技术说明

### 技术栈

后端是 h3 加 SQLite/D1；前端是 Vue 3、Vite 8、@nuxt/ui v4、vue-i18n（en/zh-CN）和 ECharts；embedding 变换沙箱用 `@cf-wasm/quickjs`；schema 和类型契约放在 `shared/` 里，前后端共享。

### LLM 中转

所有 `/v1` 端点都用 `api_keys` 表里的密钥认证，在后台「API 密钥」页创建。调用之前先在后台添加供应商。供应商分 `llm` 和 `embedding` 两类，可以随时启停，也能用 `/models` 一键把上游模型登记进来；每个供应商有上游超时和总在途并发上限两项设置，含义见「超时与并发」。

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
| `POST /v1/chat/completions` | Chat Completions 中转（流式/非流式） |
| `POST /v1/responses` | Responses API 中转（仅 `supports_responses=1` 的供应商） |
| `POST /v1/embeddings` | Embedding 中转（按约定走 `embedding` 类型供应商，可带 transform；路由本身不强制校验供应商类型） |
| `GET /v1/models` | 网关模型列表，包含 `model_routes` 中出现过的模型（含 disabled 路由）与 `models` 表中 enabled 的模型 |

流式请求需要在客户端请求里带上 `stream_options.include_usage`（Responses API 同理）。网关原样透传请求体，只从响应尾部帧解析 usage；客户端不带这个字段时，该请求的 token 用量和成本都记为 0。

#### 路由与回退

路由按 `model` 维护一份有序的供应商优先级列表。请求的模型没有显式路由时，网关回退到所有 enabled 的模型，任何启用的供应商都能接这个请求。

但 `model_routes` 里存在这个模型的行时（哪怕那些行全是 disabled），网关不再回退，直接返回 404。

#### 指定供应商

把 `model` 写成「供应商名称/模型名称」，这次请求就跳过路由，直接锁定供应商。

```json
{
  "model": "供应商A/gpt-5",
  "messages": [{ "role": "user", "content": "你好" }]
}
```

供应商名称取管理页面里的配置名称。网关只向这家供应商转发，并把上游请求的 `model` 改成 `gpt-5`；这次请求跳过亲和性和路由优先级，失败不切换其他供应商。供应商、已登记模型和已有的对应路由仍然必须启用，协议支持和并发上限照样生效。

前缀匹配扫描的是全部供应商（含 disabled），所以一个名为 `org` 的禁用供应商会把 `org/model` 请求变成 404，而不是按完整模型名继续路由。前缀后面的模型名必须是对外 ID，配了 alias 的模型只按 alias 命中，原始模型名匹配不上。供应商名称本身包含 `/` 时，优先匹配最长的已配置名称前缀。

模型名称本身可以包含 `/`，例如 `供应商A/org/model` 会转发为 `org/model`。

#### 计费

价格按「对外模型名 `model` + 供应商 `provider_id`」独立配置，单位是美元 / 1M tokens。对外模型名优先取 alias，没设 alias 就用原始模型名；指定供应商请求里的供应商前缀不算模型名的一部分。同一个模型可以为不同供应商配置不同的输入、输出和缓存读取价格。embedding 请求只记录 token 用量，成本恒为 0，不读价格表。

后台「模型与价格 → 定价」可以按模型比较各家供应商的报价，支持搜索模型或供应商、筛选供应商，点开配置或编辑后一次保存三项单价。未配置和明确设成 0 是两种状态，分开显示。没有对应组合价格的请求成本仍然计 0，不会回退到其他供应商的价格。

```
成本 = ((prompt − cached) × input_price + cached × cache_read_price + completion × output_price) / 1,000,000
```

用量归一化覆盖 chat、responses 和 embeddings 三类请求，兼容几种上游形态，包括标准的 `prompt_tokens_details.cached_tokens`、DeepSeek 的 `prompt_cache_hit_tokens`、Responses 的 `input_tokens_details` 和 Cohere 的 `meta.billed_units`。流式请求的 usage 从响应尾部解析，连同 TTFT、TPS 和时长一起计入成本，全部落进 `llm_logs`。

chat 和 responses（含流式）用本次实际响应那家供应商的价格，故障转移之后用接替供应商的价格。价格在请求完成时读取，成本写进日志后不再随改价重算，日志详情展示的是记录下来的成本，不会用当前价格反推历史账单。修改模型 alias 会改变它的定价身份，需要给新名称重新配置价格。

只有真正尝试过供应商的请求才会写 `llm_logs`，后台日志页支持分页和过滤。读请求体失败、JSON 不合法、缺 `model`、找不到可用供应商这些在路由阶段就被拒绝的请求不落日志。

流式响应被客户端取消或上游中断后，网关会结束收尾、释放并发租约并写入日志，不会切换供应商。SSE 断流记录 `error = 'upstream stream interrupted'`，用量和成本记为 0；如果同时丢失并发租约，则优先记录租约错误。`status` 保留上游已经返回的 HTTP 状态，可能仍为 200，因此需要结合 `error` 判断请求是否完整结束。4xx 响应在捕获过程中中断时，仍保留请求正文和上游错误状态，`resp_body` 为 NULL，不把部分响应记成完整正文。

#### 超时与并发

供应商的 `timeout_ms` 只对非流式 chat/responses 请求、embedding 请求和模型发现/测试生效。流式 chat/responses 不套上游超时，卡住的长流不会被中止，也不会因此切换供应商。

在途并发用租约控制，租约 TTL 10 分钟，每 3 分钟续租一次，租约存在数据库里，跨进程也安全。供应商级和路由级（model/provider 组合）两个限额都为 0 时不启用租约。chat/responses 并发满时不会排队，而是逐个尝试候选供应商，全满返回 429；embedding 请求最多排队 5 秒；租约丢失返回 503。

被会话亲和性粘住的供应商并发满时立即返回 429，不会退回其他供应商。粘性供应商出现可重试的失败（网络错误或 5xx）时，这次请求的绑定作废，后续请求重新按优先级选供应商。

#### Embedding 变换

供应商级的 `transform_code` 可以在 QuickJS 沙箱里改写 embedding 请求体和响应体。沙箱上限为指令数 10M、内存 32 MB、栈 1 MB、输入 8 MB、输出 16 MB。

### MCP 接入

MCP 端点与 LLM 共用 `api_keys` 认证，没有独立的 MCP key。上游 server 支持三种类型，`stdio` 和 `sse` 客户端只能在 Node 运行时上跑，`streamable-http` 客户端两个运行时都支持。

| 端点 | 说明 |
|---|---|
| `/mcp`（POST/GET/DELETE） | streamable-HTTP，无组 = 聚合全部 enabled servers 的 default 组 |
| `/mcp/:group` | streamable-HTTP，按命名组暴露白名单内能力 |
| `/sse`、`/sse/:group` | 兼容 SSE 传输（Node / Workers 均支持），随后 `POST /messages?sessionId=` 发消息 |

`/mcp` 是每请求无状态的 streamable-HTTP，没有会话 ID。`GET /mcp` 不带 `Accept: text/event-stream` 时返回 406，`DELETE /mcp` 关闭本次传输。SSE 端点的会话注册表保存在单进程或单 isolate 的内存里，进程重启、isolate 回收之后旧会话就断了。

#### 聚合规则

工具默认使用原始名称，只有同一组里实际暴露的工具名冲突时，才给冲突双方加上 `${serverName}__` 前缀。两台服务器都有 `search` 时，暴露成 `alpha__search` 和 `beta__search`；组内只选了其中一台，名字仍然是 `search`。原生工具名和生成出来的前缀名再次冲突时，继续添加服务器名前缀，保持唯一。

`tools/list` 和 `tools/call` 走同一套名称映射，支持上游分页，也支持没有经过 list 的直接调用，无冲突工具不保留旧的前缀别名。组内工具发现失败时两者都返回错误，不根据残缺的列表重新分配名称，避免误调用另一台服务器的工具。不提供 tools 能力的服务器不算发现失败。

prompts 仍以 `${serverName}__${name}` 的形式带前缀暴露；resources 不带前缀，按第一个提供该 URI 的 server 路由。

分组在后台维护，组内只暴露勾选过的能力白名单，空白名单等于不暴露任何能力，default 组不过滤。server 创建或启用时会自动发现能力并持久化快照，供分组选择界面使用；`POST /api/admin/mcp/reload` 可以清空上游连接缓存。

#### MCP 日志

经过认证进入 MCP 传输层的请求都会记录输入，包括 initialize、ping、能力列表、工具调用、提示词、资源、通知，以及无效请求和传输层拒绝。`mcp_logs.request_body` 保存请求原文；成功时 `response_body` 为 NULL，失败时保存完整响应，JSON-RPC error 和工具结果里的 `isError: true` 都算失败，不截断成错误摘要。取消或断连且没有响应时，保留输入并记录失败，响应仍为 NULL。

每个客户端请求记一条 `direction='call'` 日志，内部上游发现失败另记一条 `direction='upstream'`。后台 MCP 日志点击行可以查看输入、失败响应，以及原有的组、server、方法、工具、耗时、成败等信息。错误摘要继续脱敏；原始请求和失败响应可能包含敏感数据，数据库和管理端的访问权限需要自行控制。

## 许可证

[AGPL-3.0](LICENSE)
