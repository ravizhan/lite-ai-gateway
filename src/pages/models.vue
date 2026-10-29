<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { api } from '../lib/api'
import type { ModelRow, ModelRouteRow, ProviderRow } from '../../shared/api'
import { useI18n } from 'vue-i18n'
import { VueDraggable } from 'vue-draggable-plus'
import PricingPanel from '@/components/PricingPanel.vue'
import { displayModel } from '@/lib/models'

const toast = useToast()
const { t } = useI18n()
const tab = ref('models')

type ModelWithProvider = ModelRow & { provider_name: string }
type RouteWithProvider = ModelRouteRow & { provider_name: string }

const providers = ref<ProviderRow[]>([])
const models = ref<ModelWithProvider[]>([])
const routes = ref<RouteWithProvider[]>([])
const loading = ref(false)

async function loadAll() {
  loading.value = true
  try {
    const [p, m, r] = await Promise.all([
      api<ProviderRow[]>('/api/admin/providers'),
      api<ModelWithProvider[]>('/api/admin/models'),
      api<RouteWithProvider[]>('/api/admin/routes'),
    ])
    providers.value = p
    models.value = m
    routes.value = r
  } finally {
    loading.value = false
  }
}
onMounted(loadAll)

// ---------- Models ----------
const modelGroups = computed(() => {
  const map = new Map<string, ModelWithProvider[]>()
  for (const row of models.value) {
    const list = map.get(row.provider_name) ?? []
    list.push(row)
    map.set(row.provider_name, list)
  }
  return [...map.entries()]
})

async function toggleModel(row: ModelWithProvider) {
  try {
    await api(`/api/admin/models/${row.id}`, { method: 'PUT', body: { enabled: row.enabled ? 0 : 1 } })
    row.enabled = row.enabled ? 0 : 1
    toast.add({ title: row.enabled ? t('models.enabledToast') : t('models.disabledToast'), color: 'success' })
  } catch (e) {
    toast.add({ title: e instanceof Error ? e.message : t('common.operationFailed'), color: 'error' })
  }
}

// ---------- 删除模型 ----------
const deleting = ref<ModelWithProvider | null>(null)
const deleteLoading = ref(false)
const showDelete = computed({
  get: () => deleting.value !== null,
  set: (v: boolean) => {
    if (!v) deleting.value = null
  },
})
async function confirmDelete() {
  if (!deleting.value) return
  const target = deleting.value
  deleteLoading.value = true
  try {
    await api(`/api/admin/models/${target.id}`, { method: 'DELETE' })
    toast.add({ title: t('models.deleted'), color: 'success' })
    deleting.value = null
    // 原地移除条目，不走 loadAll（loading 骨架会卸载折叠面板导致全部收起）
    models.value = models.value.filter((m) => m.id !== target.id)
    // 级联可能删掉路由行，静默刷新路由；价格面板 v-if 懒挂载，切过去时自行重拉
    routes.value = await api<RouteWithProvider[]>('/api/admin/routes')
    // 选中的路由模型可能随级联删除消失
    if (routeModel.value && !routeOptions.value.some((o) => o.value === routeModel.value)) {
      routeModel.value = ''
    }
  } catch (e) {
    toast.add({ title: e instanceof Error ? e.message : t('common.deleteFailed'), color: 'error' })
  } finally {
    deleteLoading.value = false
  }
}

// ---------- Alias 映射编辑 ----------
const aliasEditingId = ref<number | null>(null)
const aliasDraft = ref('')
const aliasSaving = ref(false)

function startAliasEdit(row: ModelWithProvider) {
  aliasEditingId.value = row.id
  aliasDraft.value = row.alias
}

async function saveAlias(row: ModelWithProvider) {
  if (aliasSaving.value) return
  aliasSaving.value = true
  try {
    const saved = await api<ModelRow>(`/api/admin/models/${row.id}`, {
      method: 'PUT',
      body: { alias: aliasDraft.value.trim() },
    })
    row.alias = saved.alias
    aliasEditingId.value = null
    toast.add({ title: t('models.aliasSaved'), color: 'success' })
    // alias 变了会影响价格/路由的对外 id 分组，重拉派生数据
    routes.value = await api<RouteWithProvider[]>('/api/admin/routes')
  } catch (e) {
    toast.add({ title: e instanceof Error ? e.message : t('models.aliasSaveFailed'), color: 'error' })
  } finally {
    aliasSaving.value = false
  }
}

const showAdd = ref(false)
const addSaving = ref(false)
const addForm = reactive<{ providerId: number | undefined; model: string; alias: string }>({ providerId: undefined, model: '', alias: '' })
const addErrors = reactive({ providerId: '', model: '' })

watch(showAdd, (v) => {
  if (v) {
    addForm.providerId = undefined
    addForm.model = ''
    addForm.alias = ''
    addErrors.providerId = addErrors.model = ''
  }
})

async function addModel() {
  const providerId = addForm.providerId
  addErrors.providerId = providerId === undefined ? t('models.providerRequired') : ''
  addErrors.model = addForm.model.trim() ? '' : t('models.modelNameRequired')
  if (providerId === undefined || addErrors.model) return
  addSaving.value = true
  try {
    await api('/api/admin/models', {
      method: 'POST',
      body: {
        provider_id: providerId,
        model: addForm.model.trim(),
        ...(addForm.alias.trim() ? { alias: addForm.alias.trim() } : {}),
      },
    })
    toast.add({ title: t('models.added'), color: 'success' })
    showAdd.value = false
    const nextModels = await api<ModelWithProvider[]>('/api/admin/models')
    models.value = nextModels
  } catch (e) {
    toast.add({ title: e instanceof Error ? e.message : t('models.addFailed'), color: 'error' })
  } finally {
    addSaving.value = false
  }
}

// ---------- Routes ----------
const routeModel = ref('')
type CurrentRoute = { provider_id: number; provider_name: string; enabled: boolean; max_concurrency: number }
const currentRoutes = ref<CurrentRoute[]>([])
const routesSaving = ref(false)

const routeOptions = computed(() => {
  // models 表出现的名称全部行禁用时不出现在路由中；纯路由配置（无对应模型行）的名称保留
  const modelNames = new Set<string>()
  const enabledNames = new Set<string>()
  for (const m of models.value) {
    const name = displayModel(m)
    modelNames.add(name)
    if (m.enabled === 1) enabledNames.add(name)
  }
  const set = new Set<string>(enabledNames)
  for (const r of routes.value) {
    if (enabledNames.has(r.model) || !modelNames.has(r.model)) set.add(r.model)
  }
  return [...set].map((m) => ({ label: m, value: m }))
})

/**
 * 列出所有包含选中模型的供应商（按 provider_id 去重），
 * 已配置的按 priority 排前，未配置过的默认启用（与 models 表回退语义一致）。
 * 保留已存在 route 的 enabled/priority/max_concurrency；当前未发现但有 route 的供应商不会丢失。
 */
function buildCurrentRoutes(m: string) {
  const providerById = new Map(providers.value.map((p) => [p.id, p]))
  const existing = new Map(routes.value.filter((r) => r.model === m).map((r) => [r.provider_id, r]))
  const ids = new Set<number>()
  for (const row of models.value) {
    if (displayModel(row) === m) ids.add(row.provider_id)
  }
  for (const r of routes.value) {
    if (r.model === m) ids.add(r.provider_id)
  }
  const list = [...ids].map((pid) => {
    const ex = existing.get(pid)
    if (ex) {
      return {
        provider_id: pid,
        provider_name: ex.provider_name,
        enabled: ex.enabled === 1,
        max_concurrency: ex.max_concurrency,
        priority: ex.priority,
      }
    }
    return {
      provider_id: pid,
      provider_name: providerById.get(pid)?.name ?? String(pid),
      enabled: true,
      max_concurrency: 0,
      priority: Number.MAX_SAFE_INTEGER,
    }
  })
  list.sort((a, b) => a.priority - b.priority || a.provider_id - b.provider_id)
  currentRoutes.value = list.map((r) => ({
    provider_id: r.provider_id,
    provider_name: r.provider_name,
    enabled: r.enabled,
    max_concurrency: r.max_concurrency,
  }))
}

watch(routeModel, (m) => {
  if (m) buildCurrentRoutes(m)
  else currentRoutes.value = []
})

async function saveRoutes() {
  if (!routeModel.value || !currentRoutes.value.length) {
    toast.add({ title: t('routing.needModelProvider'), color: 'error' })
    return
  }
  routesSaving.value = true
  try {
    await api('/api/admin/routes', {
      method: 'PUT',
      body: {
        model: routeModel.value,
        routes: currentRoutes.value.map((r, i) => ({
          provider_id: r.provider_id,
          priority: i + 1,
          enabled: r.enabled ? 1 : 0,
          max_concurrency: Number(r.max_concurrency) || 0,
        })),
      },
    })
    toast.add({ title: t('routing.saved'), color: 'success' })
    routes.value = await api<RouteWithProvider[]>('/api/admin/routes')
    buildCurrentRoutes(routeModel.value)
  } catch (e) {
    toast.add({ title: e instanceof Error ? e.message : t('routing.saveFailed'), color: 'error' })
  } finally {
    routesSaving.value = false
  }
}

const tabs = computed(() => [
  { label: t('models.tabModels'), value: 'models', slot: 'models', icon: 'i-lucide-box' },
  { label: t('models.tabPricing'), value: 'prices', slot: 'prices', icon: 'i-lucide-coins' },
  { label: t('models.tabRouting'), value: 'routes', slot: 'routes', icon: 'i-lucide-route' },
])
</script>

<template>
  <PageHeader :title="t('models.title')" :description="t('models.description')" />

  <UTabs v-model="tab" :items="tabs">
    <template #models>
      <UCard>
        <template #header>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-sm font-semibold text-(--ui-text-highlighted)">{{ t('models.catalog') }}</span>
            <UButton size="sm" icon="i-lucide-plus" :label="t('models.addManually')" @click="showAdd = true" />
          </div>
        </template>
        <div v-if="loading" class="flex flex-col gap-2">
          <USkeleton v-for="i in 3" :key="i" class="h-9 w-full" />
        </div>
        <UEmpty
          v-else-if="!modelGroups.length"
          icon="i-lucide-box"
          :title="t('models.noModels')"
          :description="t('models.noModelsDesc')"
          :actions="[{ label: t('models.addManually'), icon: 'i-lucide-plus', onClick: () => (showAdd = true) }]"
        />
        <div v-else class="flex flex-col gap-1">
          <UCollapsible v-for="[name, list] in modelGroups" :key="name">
            <div
              class="flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-2 hover:bg-(--ui-bg-elevated)"
            >
              <span class="flex min-w-0 items-center gap-2 text-sm font-medium text-(--ui-text-highlighted)">
                <UIcon name="i-lucide-cloud" class="size-4 shrink-0 text-(--ui-text-dimmed)" />
                <span class="truncate">{{ name }}</span>
              </span>
              <UBadge color="neutral" variant="subtle" size="sm">{{ list.length }}</UBadge>
            </div>
            <template #content>
              <div class="flex flex-col gap-0.5 pb-1 pl-8">
                <div
                  v-for="row in list"
                  :key="row.id"
                  class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded px-2 py-1.5 text-sm"
                >
                  <span class="flex min-w-0 items-center gap-2">
                    <span class="truncate font-medium text-(--ui-text-highlighted)">{{ displayModel(row) }}</span>
                    <span
                      v-if="row.alias !== ''"
                      class="truncate font-mono text-xs text-(--ui-text-dimmed)"
                      :title="row.model"
                    >{{ row.model }}</span>
                    <UBadge v-if="row.discovered === 1" size="sm" color="primary" variant="subtle">{{ t('models.discovered') }}</UBadge>
                  </span>
                  <span class="flex shrink-0 items-center gap-1.5">
                    <template v-if="aliasEditingId === row.id">
                      <UInput
                        v-model="aliasDraft"
                        size="xs"
                        class="w-44"
                        :placeholder="t('models.aliasPlaceholder')"
                        @keyup.enter="saveAlias(row)"
                        @keyup.esc="aliasEditingId = null"
                      />
                      <UButton
                        size="xs"
                        icon="i-lucide-check"
                        :loading="aliasSaving"
                        :aria-label="t('common.save')"
                        @click="saveAlias(row)"
                      />
                      <UButton
                        size="xs"
                        color="neutral"
                        variant="ghost"
                        icon="i-lucide-x"
                        :aria-label="t('common.cancel')"
                        @click="aliasEditingId = null"
                      />
                    </template>
                    <UTooltip v-else :text="row.alias !== '' ? t('models.aliasEdit') : t('models.aliasAdd')">
                      <UButton
                        size="xs"
                        color="neutral"
                        variant="ghost"
                        icon="i-lucide-pencil"
                        :aria-label="t('models.aliasEdit')"
                        @click="startAliasEdit(row)"
                      />
                    </UTooltip>
                    <UTooltip :text="t('common.delete')">
                      <UButton
                        size="xs"
                        color="neutral"
                        variant="ghost"
                        icon="i-lucide-trash-2"
                        :aria-label="t('common.delete')"
                        @click="deleting = row"
                      />
                    </UTooltip>
                    <USwitch
                      :model-value="row.enabled === 1"
                      :aria-label="t('common.toggle', { name: displayModel(row) })"
                      @update:model-value="() => toggleModel(row)"
                    />
                  </span>
                </div>
              </div>
            </template>
          </UCollapsible>
        </div>
      </UCard>
    </template>

    <template #prices>
      <PricingPanel :providers="providers" :models="models" :routes="routes" :loading="loading" />
    </template>

    <template #routes>
      <UCard
        :title="t('routing.title')"
        :description="t('routing.description')"
      >
        <div class="flex flex-col gap-4">
          <UFormField :label="t('routing.model')" class="max-w-md">
            <USelect v-model="routeModel" :items="routeOptions" :placeholder="t('routing.selectModel')" class="w-full" />
          </UFormField>

          <template v-if="routeModel">
            <p v-if="currentRoutes.length" class="flex items-center gap-1.5 text-sm text-(--ui-text-muted)">
              <UIcon name="i-lucide-move" class="size-4" />
              {{ t('routing.dragHint') }}
            </p>
            <p v-if="currentRoutes.length" class="text-sm text-(--ui-text-muted)">
              {{ t('routing.maxConcurrency') }} — {{ t('routing.maxConcurrencyHelp') }}
            </p>
            <VueDraggable
              v-if="currentRoutes.length"
              v-model="currentRoutes"
              handle=".drag-handle"
              :animation="150"
              class="flex flex-col gap-2"
            >
              <div
                v-for="(r, i) in currentRoutes"
                :key="r.provider_id"
                class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-(--ui-border) bg-(--ui-bg-elevated) px-3 py-2"
              >
                <UIcon
                  name="i-lucide-grip-vertical"
                  class="drag-handle size-4 shrink-0 cursor-grab text-(--ui-text-dimmed) active:cursor-grabbing"
                  :aria-label="t('routing.dragHandle')"
                />
                <UBadge color="neutral" variant="subtle" class="tabular-nums">#{{ i + 1 }}</UBadge>
                <span class="min-w-0 flex-1 truncate text-sm font-medium text-(--ui-text-highlighted)">
                  {{ r.provider_name }}
                </span>
                <UInput
                  v-model.number="r.max_concurrency"
                  type="number"
                  min="0"
                  step="1"
                  class="w-24 shrink-0"
                  :aria-label="t('routing.maxConcurrencyAria', { name: r.provider_name })"
                />
                <USwitch
                  v-model="r.enabled"
                  :aria-label="t('routing.toggleEnabled', { name: r.provider_name })"
                />
              </div>
            </VueDraggable>
            <UEmpty
              v-else
              icon="i-lucide-route"
              :title="t('routing.noProviders')"
              :description="t('routing.noProvidersDesc')"
              variant="naked"
              class="py-6"
            />

            <div class="flex justify-end border-t border-(--ui-border) pt-4">
              <UButton
                :label="t('routing.saveRoutes')"
                :loading="routesSaving"
                :disabled="!currentRoutes.length"
                @click="saveRoutes"
              />
            </div>
          </template>

          <UEmpty
            v-else
            icon="i-lucide-waypoints"
            :title="t('routing.selectModelToConfig')"
            variant="naked"
            class="py-6"
          />
        </div>
      </UCard>
    </template>
  </UTabs>

  <UModal v-model:open="showAdd" :title="t('models.addTitle')" :description="t('models.addDesc')" :ui="{ footer: 'justify-end gap-2' }">
    <template #body>
      <div class="flex flex-col gap-4">
        <UFormField :label="t('cols.provider')" :required="true" :error="addErrors.providerId || undefined">
          <USelect
            v-model="addForm.providerId"
            :items="providers.map((p) => ({ label: p.name, value: p.id }))"
            :placeholder="t('models.selectProvider')"
            class="w-full"
          />
        </UFormField>
        <UFormField :label="t('cols.model')" :required="true" :error="addErrors.model || undefined">
          <UInput v-model="addForm.model" placeholder="e.g. gemini-2.5-pro" class="w-full" @keyup.enter="addModel" />
        </UFormField>
        <UFormField :label="t('models.alias')" :description="t('models.aliasHelp')">
          <UInput v-model="addForm.alias" :placeholder="t('models.aliasPlaceholder')" class="w-full" @keyup.enter="addModel" />
        </UFormField>
      </div>
    </template>
    <template #footer>
      <UButton color="neutral" variant="outline" :label="t('common.cancel')" @click="showAdd = false" />
      <UButton :label="t('models.add')" :loading="addSaving" @click="addModel" />
    </template>
  </UModal>

  <ConfirmModal
    v-model:open="showDelete"
    :title="t('models.deleteTitle')"
    :name="deleting ? displayModel(deleting) : ''"
    :detail="t('models.deleteDetail')"
    :loading="deleteLoading"
    @confirm="confirmDelete"
  />
</template>
