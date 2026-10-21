<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '../lib/api'
import type { DiscoverResult, ProviderRow } from '../../shared/api'
import { useI18n } from 'vue-i18n'

type ProviderType = ProviderRow['type']
type ProviderWithCount = ProviderRow & { model_count: number }

const toast = useToast()
const { t } = useI18n()
const rows = ref<ProviderWithCount[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    rows.value = await api<ProviderWithCount[]>('/api/admin/providers')
  } finally {
    loading.value = false
  }
}
onMounted(load)

const showForm = ref(false)
const editing = ref<ProviderWithCount | null>(null)
const discovering = ref<number | null>(null)
const deleting = ref<ProviderWithCount | null>(null)
const deleteLoading = ref(false)
const showDelete = computed({
  get: () => deleting.value !== null,
  set: (v: boolean) => {
    if (!v) deleting.value = null
  },
})

function openCreate() {
  editing.value = null
  showForm.value = true
}
function openEdit(row: ProviderWithCount) {
  editing.value = row
  showForm.value = true
}

function providerTypeLabel(type: ProviderType): string {
  return t(type === 'embedding' ? 'providerForm.embedding' : 'providerForm.llm')
}

async function onSaved() {
  showForm.value = false
  await load()
}

async function toggleEnabled(row: ProviderWithCount) {
  try {
    await api(`/api/admin/providers/${row.id}`, { method: 'PUT', body: { enabled: row.enabled ? 0 : 1 } })
    row.enabled = row.enabled ? 0 : 1
    toast.add({ title: row.enabled ? t('providers.enabledToast') : t('providers.disabledToast'), color: 'success' })
  } catch (e) {
    toast.add({ title: e instanceof Error ? e.message : t('common.operationFailed'), color: 'error' })
  }
}

async function discover(row: ProviderWithCount) {
  discovering.value = row.id
  try {
    const r = await api<DiscoverResult>(`/api/admin/providers/${row.id}/discover`, { method: 'POST' })
    toast.add({ title: t('providers.discovered', { total: r.total, added: r.added }), color: 'success' })
    await load()
  } catch (e) {
    toast.add({ title: e instanceof Error ? e.message : t('providers.discoveryFailed'), color: 'error' })
  } finally {
    discovering.value = null
  }
}

async function confirmDelete() {
  if (!deleting.value) return
  deleteLoading.value = true
  try {
    await api(`/api/admin/providers/${deleting.value.id}`, { method: 'DELETE' })
    toast.add({ title: t('providers.deleted'), color: 'success' })
    deleting.value = null
    await load()
  } catch (e) {
    toast.add({ title: e instanceof Error ? e.message : t('common.deleteFailed'), color: 'error' })
  } finally {
    deleteLoading.value = false
  }
}

const columns = computed(() => [
  { accessorKey: 'name', header: t('cols.name') },
  { accessorKey: 'type', header: t('cols.type') },
  { accessorKey: 'base_url', header: t('cols.baseUrl') },
  { accessorKey: 'supports_responses', header: t('cols.responses') },
  { accessorKey: 'timeout_ms', header: t('cols.timeout') },
  { accessorKey: 'max_concurrency', header: t('cols.maxConcurrency') },
  { accessorKey: 'model_count', header: t('cols.models') },
  { accessorKey: 'enabled', header: t('cols.enabled') },
  { id: 'actions', header: '', meta: { class: { td: 'text-end' } } },
])
</script>

<template>
  <PageHeader :title="t('providers.title')" :description="t('providers.description')">
    <UButton icon="i-lucide-plus" :label="t('providers.add')" @click="openCreate" />
  </PageHeader>

  <UCard :ui="{ body: 'p-0 sm:p-0' }">
    <UTable :data="rows" :columns="columns" :loading="loading" :empty="t('providers.empty')">
      <template #name-cell="{ row }">
        <span class="font-medium text-(--ui-text-highlighted)">{{ row.original.name }}</span>
      </template>
      <template #type-cell="{ row }">
        <UBadge color="neutral" variant="subtle">{{ providerTypeLabel(row.original.type) }}</UBadge>
      </template>
      <template #base_url-cell="{ row }">
        <span class="block max-w-64 truncate font-mono text-xs" :title="row.original.base_url">
          {{ row.original.base_url }}
        </span>
      </template>
      <template #supports_responses-cell="{ row }">
        <span v-if="row.original.type === 'embedding'" class="text-sm text-(--ui-text-muted)">{{ t('common.notApplicable') }}</span>
        <UBadge v-else :color="row.original.supports_responses === 1 ? 'success' : 'neutral'" variant="subtle">
          {{ row.original.supports_responses === 1 ? t('common.yes') : t('common.no') }}
        </UBadge>
      </template>
      <template #timeout_ms-cell="{ row }">
        <span class="tabular-nums">{{ row.original.timeout_ms > 0 ? `${row.original.timeout_ms} ms` : t('common.noLimit') }}</span>
      </template>
      <template #max_concurrency-cell="{ row }">
        <span class="tabular-nums">{{ row.original.max_concurrency > 0 ? row.original.max_concurrency : t('common.noLimit') }}</span>
      </template>
      <template #model_count-cell="{ row }">
        <span class="tabular-nums">{{ row.original.model_count }}</span>
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
          <UTooltip :text="t('providers.edit')">
            <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-pencil" :aria-label="t('providers.edit')" @click="openEdit(row.original)" />
          </UTooltip>
          <UTooltip :text="t('providers.discover')">
            <UButton
              size="sm"
              color="neutral"
              variant="ghost"
              icon="i-lucide-radar"
              :aria-label="t('providers.discover')"
              :loading="discovering === row.original.id"
              @click="discover(row.original)"
            />
          </UTooltip>
          <UTooltip :text="t('providers.delete')">
            <UButton
              size="sm"
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              :aria-label="t('providers.delete')"
              @click="deleting = row.original"
            />
          </UTooltip>
        </div>
      </template>
    </UTable>
  </UCard>

  <ProviderFormModal v-model:open="showForm" :provider="editing" @saved="onSaved" />

  <ConfirmModal
    v-model:open="showDelete"
    :title="t('providers.deleteTitle')"
    :name="deleting?.name"
    :detail="t('providers.deleteDetail')"
    :loading="deleteLoading"
    @confirm="confirmDelete"
  />
</template>
