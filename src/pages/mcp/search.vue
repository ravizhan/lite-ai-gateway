<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { api } from '../../lib/api'
import type { McpSearchPresetsResult, McpSearchUpstreamItem } from '../../../shared/mcp-search'

const toast = useToast()
const { t } = useI18n()

const rows = ref<McpSearchUpstreamItem[]>([])
const loading = ref(false)
const loaded = ref(false)
const loadError = ref('')

const presets = ref<McpSearchPresetsResult['presets']>([])
const toolDefinition = ref<McpSearchPresetsResult['tool'] | null>(null)
const protocolError = ref('')

const pending = ref(new Set<number>())

const showForm = ref(false)
const editing = ref<McpSearchUpstreamItem | null>(null)

const deleting = ref<McpSearchUpstreamItem | null>(null)
const deleteLoading = ref(false)
const showDelete = computed({
  get: () => deleting.value !== null,
  set: (v: boolean) => {
    if (!v) deleting.value = null
  },
})

/** 列表与预置/协议分开加载：协议展示失败不应把绑定列表判为失败 */
async function loadList() {
  loading.value = true
  loadError.value = ''
  try {
    rows.value = await api<McpSearchUpstreamItem[]>('/api/admin/mcp/search/upstreams')
    loaded.value = true
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : t('mcpSearch.loadFailed')
  } finally {
    loading.value = false
  }
}

async function loadProtocol() {
  protocolError.value = ''
  try {
    const result = await api<McpSearchPresetsResult>('/api/admin/mcp/search/presets')
    presets.value = result.presets
    toolDefinition.value = result.tool
  } catch (e) {
    protocolError.value = e instanceof Error ? e.message : t('mcpSearch.loadFailed')
  }
}

onMounted(() => {
  void loadList()
  void loadProtocol()
})

function reloadAll() {
  void loadList()
  if (!toolDefinition.value) void loadProtocol()
}

const protocolText = computed(() => (toolDefinition.value ? JSON.stringify(toolDefinition.value, null, 2) : ''))

function presetName(row: McpSearchUpstreamItem) {
  if (!row.preset_id) return t('mcpSearch.custom')
  const label = presets.value.find((preset) => preset.id === row.preset_id)?.label ?? row.preset_id
  return row.preset_version ? `${label} ${t('mcpSearch.presetVersion', { version: row.preset_version })}` : label
}

function openCreate() {
  editing.value = null
  showForm.value = true
}

function openEdit(row: McpSearchUpstreamItem) {
  editing.value = row
  showForm.value = true
}

async function onSaved() {
  await loadList()
}

async function toggleEnabled(row: McpSearchUpstreamItem) {
  if (pending.value.has(row.id)) return
  pending.value.add(row.id)
  try {
    const updated = await api<McpSearchUpstreamItem>(`/api/admin/mcp/search/upstreams/${row.id}`, {
      method: 'PUT',
      body: { enabled: row.enabled ? 0 : 1 },
    })
    // 以服务端返回的完整行为准（0→1 会重新校验能力快照）
    const index = rows.value.findIndex((item) => item.id === row.id)
    if (index !== -1) rows.value[index] = updated
    toast.add({
      title: updated.enabled ? t('mcpSearch.enabledToast') : t('mcpSearch.disabledToast'),
      color: 'success',
    })
  } catch (e) {
    // 失败不乐观翻转：保持原显示值并提示
    toast.add({ title: e instanceof Error ? e.message : t('common.operationFailed'), color: 'error' })
  } finally {
    pending.value.delete(row.id)
  }
}

async function confirmDelete() {
  if (!deleting.value) return
  deleteLoading.value = true
  try {
    await api(`/api/admin/mcp/search/upstreams/${deleting.value.id}`, { method: 'DELETE' })
    toast.add({ title: t('mcpSearch.deleted'), color: 'success' })
    await loadList()
    deleting.value = null
  } catch (e) {
    toast.add({ title: e instanceof Error ? e.message : t('common.deleteFailed'), color: 'error' })
  } finally {
    deleteLoading.value = false
  }
}

const columns = computed(() => [
  { accessorKey: 'server_name', header: t('mcpSearch.server') },
  { accessorKey: 'tool_name', header: t('mcpSearch.tool') },
  { id: 'preset', header: t('mcpSearch.preset') },
  { id: 'enabled', header: t('cols.enabled') },
  { id: 'actions', header: '' },
])
</script>

<template>
  <PageHeader :title="t('mcpSearch.title')" :description="t('mcpSearch.description')">
    <UButton icon="i-lucide-plus" :label="t('mcpSearch.add')" @click="openCreate" />
  </PageHeader>

  <div v-if="loading && !loaded" class="flex flex-col gap-2">
    <USkeleton v-for="i in 4" :key="i" class="h-10 w-full" />
  </div>

  <div v-else-if="!loaded && loadError" class="flex flex-col gap-3">
    <UAlert
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('mcpSearch.loadFailed')"
      :description="loadError"
    />
    <div>
      <UButton icon="i-lucide-refresh-cw" :label="t('mcpSearch.retry')" :loading="loading" @click="reloadAll" />
    </div>
  </div>

  <template v-else>
    <UAlert
      v-if="loadError"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('mcpSearch.loadFailed')"
      :description="loadError"
    >
      <template #actions>
        <UButton
          size="xs"
          color="warning"
          variant="outline"
          :label="t('mcpSearch.retry')"
          :loading="loading"
          @click="reloadAll"
        />
      </template>
    </UAlert>

    <UCard :ui="{ body: 'p-0 sm:p-0' }">
      <UTable :data="rows" :columns="columns" :empty="t('mcpSearch.empty')">
        <template #server_name-cell="{ row }">
          <div class="flex min-w-0 flex-col">
            <span class="font-medium text-(--ui-text-highlighted)">{{ row.original.server_name }}</span>
            <span v-if="row.original.server_enabled === 0" class="flex items-center gap-1 text-xs text-(--ui-warning)">
              <UIcon name="i-lucide-triangle-alert" class="size-3.5 shrink-0" />
              {{ t('mcpSearch.serverDisabled') }}
            </span>
          </div>
        </template>
        <template #tool_name-cell="{ row }">
          <div class="flex min-w-0 flex-col">
            <span class="font-mono text-xs">{{ row.original.tool_name }}</span>
            <span
              v-if="row.original.tool_available === 0"
              class="flex items-center gap-1 text-xs text-(--ui-warning)"
            >
              <UIcon name="i-lucide-triangle-alert" class="size-3.5 shrink-0" />
              {{ t('mcpSearch.toolMissing') }}
            </span>
          </div>
        </template>
        <template #preset-cell="{ row }">
          <UBadge :color="row.original.preset_id ? 'primary' : 'neutral'" variant="subtle" size="sm">
            {{ presetName(row.original) }}
          </UBadge>
        </template>
        <template #enabled-cell="{ row }">
          <USwitch
            :model-value="row.original.enabled === 1"
            :loading="pending.has(row.original.id)"
            :aria-label="t('common.toggle', { name: `${row.original.server_name} / ${row.original.tool_name}` })"
            @update:model-value="() => toggleEnabled(row.original)"
          />
        </template>
        <template #actions-cell="{ row }">
          <div class="flex items-center justify-end gap-0.5">
            <UTooltip :text="t('common.edit')">
              <UButton
                size="sm"
                color="neutral"
                variant="ghost"
                icon="i-lucide-pencil"
                :aria-label="t('common.edit')"
                :disabled="pending.has(row.original.id)"
                @click="openEdit(row.original)"
              />
            </UTooltip>
            <UTooltip :text="t('common.delete')">
              <UButton
                size="sm"
                color="error"
                variant="ghost"
                icon="i-lucide-trash-2"
                :aria-label="t('common.delete')"
                :disabled="pending.has(row.original.id)"
                @click="deleting = row.original"
              />
            </UTooltip>
          </div>
        </template>
      </UTable>
    </UCard>

    <UCard>
      <UCollapsible class="min-w-0">
        <button type="button" class="flex w-full cursor-pointer items-center justify-between gap-2">
          <span class="flex items-center gap-1.5 text-sm font-semibold text-(--ui-text-highlighted)">
            <UIcon
              name="i-lucide-chevron-right"
              class="size-4 text-(--ui-text-dimmed) transition-transform [[data-state=open]_&]:rotate-90"
            />
            {{ t('mcpSearch.protocol') }}
          </span>
        </button>
        <template #content>
          <div v-if="protocolText" class="mt-3 flex justify-end">
            <CopyButton :text="protocolText" />
          </div>
          <UAlert
            v-if="protocolError"
            class="mt-3"
            color="error"
            variant="subtle"
            :title="t('mcpSearch.loadFailed')"
            :description="protocolError"
          >
            <template #actions>
              <UButton size="xs" color="error" variant="outline" :label="t('mcpSearch.retry')" @click="loadProtocol" />
            </template>
          </UAlert>
          <pre
            v-else-if="protocolText"
            class="mt-3 max-h-72 min-w-0 max-w-full overflow-auto rounded-md bg-(--ui-bg-muted) p-3 font-mono text-xs leading-relaxed"
          >{{ protocolText }}</pre>
          <USkeleton v-else class="mt-3 h-24 w-full" />
        </template>
      </UCollapsible>
    </UCard>
  </template>

  <McpSearchUpstreamFormModal v-model:open="showForm" :upstream="editing" @saved="onSaved" />

  <ConfirmModal
    v-model:open="showDelete"
    :title="t('mcpSearch.deleteTitle')"
    :name="deleting ? `${deleting.server_name} / ${deleting.tool_name}` : undefined"
    :detail="t('mcpSearch.deleteDetail')"
    :loading="deleteLoading"
    @confirm="confirmDelete"
  />
</template>
