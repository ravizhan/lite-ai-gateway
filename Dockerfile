# syntax=docker/dockerfile:1

# 构建镜像默认走 docker.1ms.run 加速；海外直连可 --build-arg NODE_IMAGE=node:26-trixie-slim
ARG NODE_IMAGE=docker.1ms.run/library/node:26-trixie-slim
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs26-debian13:nonroot

# ---------- 构建阶段：前端 dist/ + 后端单文件 mjs ----------
FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION=12.3.4
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# npm/pnpm 共用 /root/.npmrc 的 registry（写入镜像层，不污染运行期环境变量）
RUN npm config set registry $NPM_REGISTRY && npm install -g pnpm@$PNPM_VERSION
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm build:server --no-exe
# 运行镜像没有 shell；在构建阶段准备数据目录。
RUN mkdir -p /app/runtime-data

# ---------- 运行阶段：Distroless Node.js 26，无 node_modules ----------
FROM ${RUNTIME_IMAGE} AS runtime
ENV NODE_ENV=production
ENV PATH=/nodejs/bin:$PATH
WORKDIR /app
COPY --from=build /app/dist-bundle/server/node.mjs ./server/node.mjs
COPY --from=build /app/server/db/schema.sql ./server/schema.sql
COPY --from=build /app/dist ./dist

# 延续原镜像的 uid/gid 1000，兼容已有数据卷。
COPY --from=build --chown=1000:1000 /app/runtime-data /app/data
ENV DATABASE_PATH=/app/data/gateway.db
ENV PORT=8788
EXPOSE 8788
USER 1000:1000

# Distroless 没有 shell，健康检查必须用 exec 形式。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# 继承 Distroless 的 Node entrypoint。
CMD ["server/node.mjs"]
