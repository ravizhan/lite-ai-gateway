<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '../../lib/api'
import type { McpServerRow, McpServerType, McpServerWithCounts, McpTestResult } from '../../../shared/api'
import { useI18n } from 'vue-i18n'

const toast = useToast()
const { t } = useI18n()
const rows = ref<McpServerWithCounts[]>([])
const loading = ref(false)
const showForm = ref(false)
const editing = ref<McpServerRow | null>(null)
const testing = ref<number | null>(null)
const reloading = ref(false)
const deleting = ref<McpServerRow | null>(null)
const deleteLoading = ref(false)
const showDelete = computed({
  get: () => deleting.value !== null,
  set: (v: boolean) => {
    if (!v) deleting.value = null
  },
})

async function load() {
  loading.value = true
  try {
    rows.value = await api<McpServerWithCounts[]>('/api/admin/mcp/servers')
  } finally {
    loading.value = false
  }
}
onMounted(load)

function openCreate() {
  editing.value = null
  showForm.value = true
}
function openEdit(row: McpServerRow) {
  editing.value = row
  showForm.value = true
}
async function onSaved() {
  showForm.value = false
  await load()
}

async function toggleEnabled(row: McpServerRow) {
  try {
    await api(`/api/admin/mcp/servers/${row.id}`, { method: 'PUT', body: { enabled: row.enabled ? 0 : 1 } })
    row.enabled = row.enabled ? 0 : 1
    toast.add({ title: row.enabled ? t('mcpServers.enabledToast') : t('mcpServers.disabledToast'), color: 'success' })
  } catch (e) {
    toast.add({ title: e instanceof Error ? e.message : t('common.operationFailed'), color: 'error' })
  }
}

async function test(row: McpServerRow) {
  testing.value = row.id
  try {
    const r = await api<McpTestResult>(`/api/admin/mcp/servers/${row.id}/test`, { method: 'POST' })
    if (r.ok) {
      toast.add({ title: t('mcpServers.connected', { count: r.tools }), color: 'success' })
    } else {
      toast.add({ title: r.error ? t('mcpServers.connectionFailedDetail', { error: r.error }) : t('mcpServers.connectionFailed'), color: 'error' })
    }
  } catch (e) {
    toast.add({ title: e instanceof Error ? e.message : t('mcpServers.connectionFailed'), color: 'error' })
  } finally {
    testing.value = null
  }
}

async function confirmDelete() {
  if (!deleting.value) return
  deleteLoading.value = true
  try {
    await api(`/api/admin/mcp/servers/${deleting.value.id}`, { method: 'DELETE' })
    toast.add({ title: t('mcpServers.deleted'), color: 'success' })
    deleting.value = null
    await load()
  } catch (e) {
    toast.add({ title: e instanceof Error ? e.message : t('common.deleteFailed'), color: 'error' })
  } finally {
    deleteLoading.value = false
  }
}

async function reloadConnections() {
  reloading.value = true
  try {
    await api('/api/admin/mcp/reload', { method: 'POST' })
    toast.add({ title: t('mcpServers.reloaded'), color: 'success' })
  } catch (e) {
    toast.add({ title: e instanceof Error ? e.message : t('mcpServers.reloadFailed'), color: 'error' })
  } finally {
    reloading.value = false
  }
}

function typeColor(type: McpServerType) {
  return type === 'stdio' ? 'neutral' : type === 'sse' ? 'warning' : 'primary'
}

const columns = computed(() => [
  { accessorKey: 'name', header: t('cols.name') },
  { accessorKey: 'type', header: t('cols.type') },
  { accessorKey: 'target', header: t('cols.target') },
  { accessorKey: 'capabilities', header: t('cols.capabilities') },
  { accessorKey: 'enabled', header: t('cols.enabled') },
  { id: 'actions', header: '' },
])
</script>

<template>
  <PageHeader :title="t('mcpServers.title')" :description="t('mcpServers.description')">
    <UButton icon="i-lucide-refresh-cw" :label="t('mcpServers.reload')" variant="outline" :loading="reloading" @click="reloadConnections" />
    <UButton icon="i-lucide-plus" :label="t('mcpServers.add')" @click="openCreate" />
  </PageHeader>

  <UCard :ui="{ body: 'p-0 sm:p-0' }">
    <UTable :data="rows" :columns="columns" :loading="loading" :empty="t('mcpServers.empty')">
      <template #name-cell="{ row }">
        <span class="font-medium text-(--ui-text-highlighted)">{{ row.original.name }}</span>
      </template>
      <template #type-cell="{ row }">
        <UBadge :color="typeColor(row.original.type)" variant="subtle">{{ row.original.type }}</UBadge>
      </template>
      <template #target-cell="{ row }">
        <span class="block max-w-72 truncate font-mono text-xs" :title="row.original.command ?? row.original.url ?? ''">
          {{ row.original.command ?? row.original.url ?? '-' }}
        </span>
      </template>
      <template #capabilities-cell="{ row }">
        <div class="flex items-center gap-1">
          <UTooltip :text="t('mcpCapabilities.tools')">
            <UBadge color="primary" variant="subtle" size="sm">{{ row.original.tool_count }}</UBadge>
          </UTooltip>
          <UTooltip :text="t('mcpCapabilities.prompts')">
            <UBadge color="warning" variant="subtle" size="sm">{{ row.original.prompt_count }}</UBadge>
          </UTooltip>
          <UTooltip :text="t('mcpCapabilities.resources')">
            <UBadge color="neutral" variant="subtle" size="sm">{{ row.original.resource_count }}</UBadge>
          </UTooltip>
        </div>
      </template>
      <template #enabled-cell="{ row }">
        <USwitch
          :model-value="row.original.enabled === 1"
          :aria-label="t('common.toggle', { name: row.original.name })"
          @update:model-value="() => toggleEnabled(row.original)"
        />
      </template>
      <template #actions-cell="{ row }">
        <div class="flex items-center justify-end gap-0.5">
          <UTooltip :text="t('mcpServers.edit')">
            <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-pencil" :aria-label="t('mcpServers.edit')" @click="openEdit(row.original)" />
          </UTooltip>
          <UTooltip :text="t('mcpServers.test')">
            <UButton
              size="sm"
              color="neutral"
              variant="ghost"
              icon="i-lucide-plug-zap"
              :aria-label="t('mcpServers.test')"
              :loading="testing === row.original.id"
              @click="test(row.original)"
            />
          </UTooltip>
          <UTooltip :text="t('mcpServers.delete')">
            <UButton
              size="sm"
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              :aria-label="t('mcpServers.delete')"
              @click="deleting = row.original"
            />
          </UTooltip>
        </div>
      </template>
    </UTable>
  </UCard>

  <McpServerFormModal v-model:open="showForm" :server="editing" @saved="onSaved" />

  <ConfirmModal
    v-model:open="showDelete"
    :title="t('mcpServers.deleteTitle')"
    :name="deleting?.name"
    :detail="t('mcpServers.deleteDetail')"
    :loading="deleteLoading"
    @confirm="confirmDelete"
  />
</template>
