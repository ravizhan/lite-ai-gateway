<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '../lib/api'
import { formatLocalTs } from '../lib/time'
import type { ApiKeyRow } from '../../shared/api'
import { useI18n } from 'vue-i18n'

const toast = useToast()
const { t } = useI18n()
const rows = ref<ApiKeyRow[]>([])
const loading = ref(false)
const showForm = ref(false)
const creating = ref(false)
const newKeyResult = ref<ApiKeyRow | null>(null)
const deleting = ref<ApiKeyRow | null>(null)
const deleteLoading = ref(false)
const showDelete = computed({
  get: () => deleting.value !== null,
  set: (v: boolean) => {
    if (!v) deleting.value = null
  },
})
const showResult = computed({
  get: () => newKeyResult.value !== null,
  set: (v: boolean) => {
    if (!v) newKeyResult.value = null
  },
})

const name = ref('')
const nameError = ref('')

async function load() {
  loading.value = true
  try {
    rows.value = await api<ApiKeyRow[]>('/api/admin/keys')
  } finally {
    loading.value = false
  }
}
onMounted(load)

function maskKey(key: string) {
  return key.length > 4 ? `sk-••••${key.slice(-4)}` : 'sk-••••'
}

async function createKey() {
  nameError.value = name.value.trim() ? '' : t('validation.nameRequired')
  if (nameError.value) return
  creating.value = true
  try {
    const created = await api<ApiKeyRow>('/api/admin/keys', {
      method: 'POST',
      body: { name: name.value.trim() },
    })
    toast.add({ title: t('keys.created'), color: 'success' })
    showForm.value = false
    name.value = ''
    nameError.value = ''
    newKeyResult.value = created
    await load()
  } catch (e) {
    toast.add({ title: e instanceof Error ? e.message : t('keys.createFailed'), color: 'error' })
  } finally {
    creating.value = false
  }
}

async function toggleEnabled(row: ApiKeyRow) {
  try {
    await api(`/api/admin/keys/${row.id}`, { method: 'PUT', body: { enabled: row.enabled ? 0 : 1 } })
    row.enabled = row.enabled ? 0 : 1
    toast.add({ title: row.enabled ? t('keys.enabledToast') : t('keys.disabledToast'), color: 'success' })
  } catch (e) {
    toast.add({ title: e instanceof Error ? e.message : t('common.operationFailed'), color: 'error' })
  }
}

async function confirmDelete() {
  if (!deleting.value) return
  deleteLoading.value = true
  try {
    await api(`/api/admin/keys/${deleting.value.id}`, { method: 'DELETE' })
    toast.add({ title: t('keys.deleted'), color: 'success' })
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
  { accessorKey: 'key', header: t('cols.key') },
  { accessorKey: 'enabled', header: t('cols.enabled') },
  { accessorKey: 'created_at', header: t('cols.created') },
  { id: 'actions', header: '' },
])
</script>

<template>
  <PageHeader :title="t('keys.title')" :description="t('keys.description')">
    <UButton icon="i-lucide-plus" :label="t('keys.create')" @click="showForm = true" />
  </PageHeader>

  <UCard :ui="{ body: 'p-0 sm:p-0' }">
    <UTable :data="rows" :columns="columns" :loading="loading" :empty="t('keys.empty')">
      <template #name-cell="{ row }">
        <span class="font-medium text-(--ui-text-highlighted)">{{ row.original.name }}</span>
      </template>
      <template #key-cell="{ row }">
        <div class="flex items-center gap-1">
          <span class="font-mono text-sm">{{ maskKey(row.original.key) }}</span>
          <CopyButton :text="row.original.key" />
        </div>
      </template>
      <template #enabled-cell="{ row }">
        <USwitch
          :model-value="row.original.enabled === 1"
          :aria-label="t('common.toggle', { name: row.original.name })"
          @update:model-value="() => toggleEnabled(row.original)"
        />
      </template>
      <template #created_at-cell="{ row }">
        <span class="whitespace-nowrap tabular-nums">{{ formatLocalTs(row.original.created_at, 'date') }}</span>
      </template>
      <template #actions-cell="{ row }">
        <div class="text-end">
          <UTooltip :text="t('common.delete')">
            <UButton
              size="sm"
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              :aria-label="t('common.delete')"
              @click="deleting = row.original"
            />
          </UTooltip>
        </div>
      </template>
    </UTable>
  </UCard>

  <UModal v-model:open="showForm" :title="t('keys.createTitle')" :description="t('keys.createDesc')" :ui="{ footer: 'justify-end gap-2' }">
    <template #body>
      <UFormField :label="t('common.name')" :required="true" :error="nameError || undefined">
        <UInput v-model="name" :placeholder="t('keys.namePlaceholder')" class="w-full" @keyup.enter="createKey" />
      </UFormField>
    </template>
    <template #footer>
      <UButton color="neutral" variant="outline" :label="t('common.cancel')" @click="showForm = false" />
      <UButton :label="t('common.create')" :loading="creating" @click="createKey" />
    </template>
  </UModal>

  <UModal v-model:open="showResult" :title="t('keys.resultTitle')" :ui="{ footer: 'justify-end' }">
    <template #body>
      <div class="flex flex-col gap-3">
        <UAlert
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="t('keys.shownOnce')"
          :description="t('keys.resultDesc')"
        />
        <div class="flex items-center gap-2 rounded-md border border-(--ui-border) bg-(--ui-bg-elevated) px-3 py-2">
          <span class="min-w-0 flex-1 break-all font-mono text-sm">{{ newKeyResult?.key }}</span>
          <CopyButton :text="newKeyResult?.key ?? ''" />
        </div>
      </div>
    </template>
    <template #footer>
      <UButton :label="t('common.done')" @click="newKeyResult = null" />
    </template>
  </UModal>

  <ConfirmModal
    v-model:open="showDelete"
    :title="t('keys.deleteTitle')"
    :name="deleting?.name"
    :detail="t('keys.deleteDetail')"
    :loading="deleteLoading"
    @confirm="confirmDelete"
  />
</template>
