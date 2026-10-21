<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '../../lib/api'
import {
  capabilityDetail,
  exposedDefinitionText,
  exposedToolNames,
  loadO200kCounter,
  type McpPromptEditTarget,
} from '../../lib/mcp-prompt'
import type { McpCapabilityKind, McpToolPromptsResult } from '../../../shared/api'

interface Row {
  key: string
  kind: McpCapabilityKind
  name: string
  detail: unknown
  defaultPrompt: string
  prompt: string
  overridden: boolean
}

const { t } = useI18n()
const servers = ref<McpToolPromptsResult['servers']>([])
const loading = ref(false)
const serverFilter = ref<string | null>(null)
const kindFilter = ref<McpCapabilityKind | null>(null)
const counter = ref<((value: string) => number) | null>(null)
const editing = ref<McpPromptEditTarget | null>(null)
const showEdit = computed({
  get: () => editing.value !== null,
  set: (v: boolean) => {
    if (!v) editing.value = null
  },
})

const KIND_ICONS: Record<McpCapabilityKind, string> = {
  tool: 'i-lucide-wrench',
  prompt: 'i-lucide-message-square-text',
  resource: 'i-lucide-database',
}

async function load() {
  loading.value = true
  try {
    const result = await api<McpToolPromptsResult>('/api/admin/mcp/tools')
    servers.value = result.servers
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await load()
  // 首屏渲染后再加载 tokenizer chunk（独立 chunk，计数出现前表格已可见）
  counter.value = await loadO200kCounter()
  // 编码字典加载期间后端可能已写入覆盖，重拉一次使计数与数据一致
  await load()
})

const serverOptions = computed(() => [
  { label: t('mcpTools.allServers'), value: null },
  ...servers.value.map((s) => ({ label: s.server_name, value: String(s.server_id) })),
])
const kindOptions = computed(() => [
  { label: t('mcpTools.allKinds'), value: null },
  { label: t('mcpTools.kind_tool'), value: 'tool' },
  { label: t('mcpTools.kind_prompt'), value: 'prompt' },
  { label: t('mcpTools.kind_resource'), value: 'resource' },
])

/** 展示范围 = 服务器筛选 + kind 筛选；token 总和与列表同口径 */
const visibleServers = computed(() =>
  servers.value
    .filter((s) => serverFilter.value === null || String(s.server_id) === serverFilter.value)
    .map((s) => ({
      ...s,
      rows: s.items
        .filter((c) => kindFilter.value === null || c.kind === kindFilter.value)
        .map<Row>((c) => ({
          key: `${c.kind}:${c.name}`,
          kind: c.kind,
          name: c.name,
          detail: c.detail,
          defaultPrompt: c.default_prompt,
          prompt: c.prompt,
          overridden: c.overridden === 1,
        })),
    })),
)

const visibleTotal = computed(() => visibleServers.value.reduce((sum, s) => sum + s.rows.length, 0))

/** 暴露范围（默认组 = 全部 enabled servers）内的工具名：token 统计与 hub 命名一致 */
const toolNames = computed(() => exposedToolNames(servers.value))

function exposedName(serverId: number, row: Row): string | undefined {
  return row.kind === 'tool' ? toolNames.value.get(`${serverId}:${row.name}`) : undefined
}

function rowTokens(serverId: number, serverName: string, row: Row): number | null {
  if (!counter.value) return null
  return counter.value(exposedDefinitionText(serverName, row, row.prompt, row.overridden, exposedName(serverId, row)))
}

function serverTokens(server: (typeof visibleServers.value)[number]): number | null {
  if (!counter.value) return null
  let total = 0
  for (const row of server.rows) {
    total += counter.value(
      exposedDefinitionText(server.server_name, row, row.prompt, row.overridden, exposedName(server.server_id, row)),
    )
  }
  return total
}

function openEdit(server: (typeof visibleServers.value)[number], row: Row) {
  editing.value = {
    serverId: server.server_id,
    serverName: server.server_name,
    kind: row.kind,
    name: row.name,
    exposedToolName: exposedName(server.server_id, row),
    detail: row.detail,
    defaultPrompt: row.defaultPrompt,
    prompt: row.prompt,
    overridden: row.overridden,
  }
}

async function onSaved() {
  editing.value = null
  await load()
}
</script>

<template>
  <PageHeader :title="t('mcpTools.title')" :description="t('mcpTools.description')" />

  <div class="flex flex-wrap items-center gap-2">
    <USelect v-model="serverFilter" :items="serverOptions" class="w-48" />
    <USelect v-model="kindFilter" :items="kindOptions" class="w-36" />
    <span class="text-sm text-(--ui-text-muted)">{{ t('mcpTools.entries', { count: visibleTotal }) }}</span>
  </div>

  <div v-if="loading && !servers.length" class="flex flex-col gap-2">
    <USkeleton v-for="i in 4" :key="i" class="h-10 w-full" />
  </div>

  <UEmpty
    v-else-if="!visibleTotal"
    icon="i-lucide-package-open"
    :title="t('mcpTools.empty')"
    :description="t('mcpTools.emptyDesc')"
  />

  <UCard v-for="server in visibleServers" :key="server.server_id" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-medium text-(--ui-text-highlighted)">{{ server.server_name }}</span>
          <UBadge color="neutral" variant="subtle">{{ server.server_type }}</UBadge>
          <UBadge :color="server.enabled ? 'success' : 'neutral'" variant="subtle">
            {{ server.enabled ? t('common.enabled') : t('common.disabled') }}
          </UBadge>
        </div>
        <UBadge v-if="serverTokens(server) !== null" color="neutral" variant="subtle">
          {{ t('mcpTools.tokensTotal', { count: serverTokens(server)!.toLocaleString() }) }}
        </UBadge>
      </div>
    </template>

    <UEmpty v-if="!server.rows.length" icon="i-lucide-filter" :title="t('mcpTools.emptyKind')" />

    <UAccordion
      v-else
      type="multiple"
      :items="server.rows.map((row) => ({ value: row.key, icon: KIND_ICONS[row.kind], row }))"
    >
      <template #leading="{ item }">
        <div class="flex min-w-0 flex-1 items-center gap-2 ps-2">
          <UIcon :name="item.icon" class="size-4 shrink-0 text-(--ui-text-muted)" />
          <span class="min-w-0 truncate font-mono text-sm">{{ item.row.name }}</span>
          <UBadge color="neutral" variant="subtle" size="sm">{{ t(`mcpTools.kind_${item.row.kind}`) }}</UBadge>
          <UBadge v-if="item.row.overridden" color="primary" variant="subtle" size="sm">{{ t('mcpTools.custom') }}</UBadge>
        </div>
      </template>
      <template #trailing="{ item }">
        <div class="flex shrink-0 items-center gap-1" @click.stop>
          <span v-if="rowTokens(server.server_id, server.server_name, item.row) !== null" class="text-xs tabular-nums text-(--ui-text-muted)">
            {{ t('mcpTools.tokens', { count: rowTokens(server.server_id, server.server_name, item.row)!.toLocaleString() }) }}
          </span>
          <UButton size="xs" variant="ghost" icon="i-lucide-pencil" :label="t('common.edit')" @click="openEdit(server, item.row)" />
        </div>
      </template>
      <template #content="{ item }">
        <div class="flex min-w-0 flex-col gap-2 ps-8 pe-2 pb-3.5 text-sm">
          <p v-if="item.row.prompt" class="break-words whitespace-pre-wrap text-(--ui-text-muted)">{{ item.row.prompt }}</p>
          <p v-else class="text-(--ui-text-dimmed) italic">{{ t('mcpTools.noPrompt') }}</p>
          <div v-if="item.row.kind === 'tool'" class="flex min-w-0 flex-col gap-1">
            <span class="text-xs font-medium tracking-wide text-(--ui-text-muted) uppercase">{{ t('mcpCapabilities.inputSchema') }}</span>
            <pre class="max-h-64 min-w-0 max-w-full overflow-auto rounded-md bg-(--ui-bg-muted) p-2.5 font-mono text-xs leading-relaxed text-(--ui-text)">{{ JSON.stringify(capabilityDetail(item.row.detail).inputSchema ?? {}, null, 2) }}</pre>
          </div>
          <div v-if="item.row.kind === 'resource'" class="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span class="shrink-0 text-xs font-medium tracking-wide text-(--ui-text-muted) uppercase">{{ t('mcpCapabilities.uri') }}</span>
            <code class="min-w-0 break-all font-mono text-xs text-(--ui-text-highlighted)">{{ item.row.name }}</code>
          </div>
        </div>
      </template>
    </UAccordion>
  </UCard>

  <McpPromptEditModal v-model:open="showEdit" :target="editing" @saved="onSaved" />
</template>
