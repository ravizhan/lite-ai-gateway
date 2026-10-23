<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api } from '../lib/api'
import type { ProviderModelsSyncResult } from '../../shared/api'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  providerId: number | null
  providerName: string
  /** 上游发现的模型 id */
  models: string[]
  /** 该供应商已在模型目录中的模型 id */
  existing: string[]
}>()
const emit = defineEmits<{ saved: [] }>()
const open = defineModel<boolean>('open', { default: false })

const toast = useToast()
const { t } = useI18n()
const saving = ref(false)
const query = ref('')
const selected = ref(new Set<string>())

const existingSet = computed(() => new Set(props.existing))
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return q ? props.models.filter((m) => m.toLowerCase().includes(q)) : props.models
})
const allFilteredChecked = computed(() => {
  const list = filtered.value
  if (!list.length) return false
  const checked = list.filter((m) => selected.value.has(m)).length
  if (checked === 0) return false
  return checked === list.length ? true : 'indeterminate'
})
const pending = computed(() => {
  const add = props.models.filter((m) => selected.value.has(m) && !existingSet.value.has(m))
  const remove = props.models.filter((m) => !selected.value.has(m) && existingSet.value.has(m))
  return { add, remove }
})

watch(open, (v) => {
  if (!v) return
  query.value = ''
  selected.value = new Set(props.models.filter((m) => existingSet.value.has(m)))
})

function toggle(model: string, checked: boolean) {
  const next = new Set(selected.value)
  if (checked) next.add(model)
  else next.delete(model)
  selected.value = next
}

function toggleFiltered(checked: boolean) {
  const next = new Set(selected.value)
  for (const m of filtered.value) {
    if (checked) next.add(m)
    else next.delete(m)
  }
  selected.value = next
}

async function submit() {
  if (props.providerId === null) return
  const { add, remove } = pending.value
  if (!add.length && !remove.length) {
    open.value = false
    return
  }
  saving.value = true
  try {
    const r = await api<ProviderModelsSyncResult>(`/api/admin/providers/${props.providerId}/models`, {
      method: 'POST',
      body: { add, remove },
    })
    toast.add({ title: t('discoverModels.saved', { added: r.added, removed: r.removed }), color: 'success' })
    emit('saved')
  } catch (e) {
    toast.add({ title: e instanceof Error ? e.message : t('discoverModels.saveFailed'), color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('discoverModels.title', { name: providerName })"
    :description="t('discoverModels.description')"
    :ui="{ footer: 'justify-between gap-2' }"
  >
    <template #body>
      <UEmpty v-if="!models.length" icon="i-lucide-box" :title="t('discoverModels.empty')" />
      <div v-else class="flex flex-col gap-3">
        <UInput
          v-model="query"
          icon="i-lucide-search"
          :placeholder="t('discoverModels.searchPlaceholder')"
          class="w-full"
        />
        <div class="flex items-center justify-between gap-2 px-1">
          <UCheckbox
            :model-value="allFilteredChecked"
            :label="t('discoverModels.selectAll')"
            :disabled="!filtered.length"
            @update:model-value="toggleFiltered($event === true)"
          />
          <span class="text-xs text-(--ui-text-muted) tabular-nums">
            {{ t('discoverModels.selectedCount', { selected: selected.size, total: models.length }) }}
          </span>
        </div>
        <div class="flex max-h-80 flex-col gap-1 overflow-y-auto rounded-md border border-(--ui-border) p-2">
          <p v-if="!filtered.length" class="px-1 py-2 text-sm text-(--ui-text-muted)">{{ t('discoverModels.noMatch') }}</p>
          <div v-for="m in filtered" :key="m" class="flex items-center justify-between gap-2 px-1 py-0.5">
            <UCheckbox
              :model-value="selected.has(m)"
              :label="m"
              :ui="{ label: 'font-mono text-xs break-all' }"
              @update:model-value="toggle(m, $event === true)"
            />
            <UBadge v-if="existingSet.has(m)" size="sm" color="neutral" variant="subtle" class="shrink-0">
              {{ t('discoverModels.added') }}
            </UBadge>
          </div>
        </div>
      </div>
    </template>
    <template #footer>
      <span class="text-xs text-(--ui-text-muted)">
        {{ t('discoverModels.pending', { add: pending.add.length, remove: pending.remove.length }) }}
      </span>
      <div class="flex gap-2">
        <UButton color="neutral" variant="outline" :label="t('common.cancel')" @click="open = false" />
        <UButton :label="t('common.save')" :loading="saving" :disabled="!models.length" @click="submit" />
      </div>
    </template>
  </UModal>
</template>
