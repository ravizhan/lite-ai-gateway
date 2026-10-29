<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { ModelRow, ModelRouteRow, PriceRow, ProviderRow } from '../../shared/api'
import { api } from '@/lib/api'
import { displayModel } from '@/lib/models'

type ModelWithProvider = ModelRow & { provider_name?: string }
type RouteWithProvider = ModelRouteRow & { provider_name?: string }

type PriceCandidate = {
  model: string
  provider_id: number
  provider_name: string
  configured: boolean
  input_price: number | null
  output_price: number | null
  cache_read_price: number | null
}

type PriceGroup = {
  model: string
  rows: PriceCandidate[]
}

type ParsedDraft = { input: number; output: number; cacheRead: number }

const props = defineProps<{
  providers: ProviderRow[]
  models: ModelWithProvider[]
  routes: RouteWithProvider[]
  loading: boolean
}>()

const toast = useToast()
const { t } = useI18n()

const persistedPrices = ref<PriceRow[]>([])
const loaded = ref(false)
const pricesLoading = ref(false)
const loadError = ref('')
const searchTerm = ref('')
const providerFilter = ref<number | null>(null)

const editOpen = ref(false)
const selected = ref<PriceCandidate | null>(null)
const saving = ref(false)
const saveError = ref('')
const draft = reactive({ input: '', output: '', cacheRead: '' })
const draftErrors = reactive({ input: '', output: '', cacheRead: '' })

function candidateKey(model: string, providerId: number): string {
  return `${model}\u0000${providerId}`
}

function clearDraftErrors() {
  draftErrors.input = ''
  draftErrors.output = ''
  draftErrors.cacheRead = ''
}

async function loadPrices() {
  pricesLoading.value = true
  try {
    persistedPrices.value = await api<PriceRow[]>('/api/admin/prices')
    loaded.value = true
    loadError.value = ''
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : t('pricing.loadFailed')
  } finally {
    pricesLoading.value = false
  }
}

onMounted(loadPrices)

const providerNames = computed(() => new Map(props.providers.map((provider) => [provider.id, provider.name])))

const candidates = computed<PriceCandidate[]>(() => {
  const pairs = new Map<string, { model: string; provider_id: number }>()
  const add = (model: string, providerId: number) => {
    if (!model || !Number.isFinite(providerId)) return
    pairs.set(candidateKey(model, providerId), { model, provider_id: providerId })
  }

  for (const row of props.models) add(displayModel(row), row.provider_id)
  for (const row of props.routes) add(row.model, row.provider_id)
  for (const row of persistedPrices.value) add(row.model, row.provider_id)

  // 禁用模型严格隐藏（含已配置价格行）：pair 在 models 表存在且全部行 enabled=0 时剔除；
  // 无对应 models 行的 pair（仅来自路由/历史价格）保留
  const pairEnabled = new Map<string, boolean>()
  for (const row of props.models) {
    const key = candidateKey(displayModel(row), row.provider_id)
    if (row.enabled === 1) pairEnabled.set(key, true)
    else if (!pairEnabled.has(key)) pairEnabled.set(key, false)
  }

  const pricesByPair = new Map(
    persistedPrices.value.map((price) => [candidateKey(price.model, price.provider_id), price]),
  )

  return [...pairs.values()]
    .filter((pair) => pairEnabled.get(candidateKey(pair.model, pair.provider_id)) !== false)
    .map((pair) => {
      const price = pricesByPair.get(candidateKey(pair.model, pair.provider_id))
      return {
        ...pair,
        provider_name: providerNames.value.get(pair.provider_id) ?? t('pricing.unknownProvider', { id: pair.provider_id }),
        configured: price !== undefined,
        input_price: price?.input_price ?? null,
        output_price: price?.output_price ?? null,
        cache_read_price: price?.cache_read_price ?? null,
      }
    })
})

const providerItems = computed(() => [
  { label: t('pricing.allProviders'), value: null },
  ...props.providers.map((provider) => ({ label: provider.name, value: provider.id })),
])

const filteredCandidates = computed(() => {
  const query = searchTerm.value.trim().toLocaleLowerCase()
  return candidates.value.filter((row) => {
    const matchesProvider = providerFilter.value === null || row.provider_id === providerFilter.value
    if (!matchesProvider) return false
    if (!query) return true
    return row.model.toLocaleLowerCase().includes(query) || row.provider_name.toLocaleLowerCase().includes(query)
  })
})

const filteredGroups = computed<PriceGroup[]>(() => {
  const groups = new Map<string, PriceCandidate[]>()
  for (const row of filteredCandidates.value) {
    const list = groups.get(row.model) ?? []
    list.push(row)
    groups.set(row.model, list)
  }
  return [...groups.entries()].map(([model, rows]) => ({
    model,
    rows: rows.sort((a, b) => a.provider_name.localeCompare(b.provider_name) || a.provider_id - b.provider_id),
  }))
})

const isLoading = computed(() => props.loading || (!loaded.value && pricesLoading.value))
const hasCandidates = computed(() => candidates.value.length > 0)
const isFilteredEmpty = computed(() => hasCandidates.value && filteredCandidates.value.length === 0)

function formatPrice(value: number | null): string {
  return value === null ? '—' : `$${String(value)}`
}

function startEdit(row: PriceCandidate) {
  selected.value = row
  draft.input = row.input_price === null ? '' : String(row.input_price)
  draft.output = row.output_price === null ? '' : String(row.output_price)
  draft.cacheRead = row.cache_read_price === null ? '' : String(row.cache_read_price)
  clearDraftErrors()
  saveError.value = ''
  editOpen.value = true
}

// UInput type="number" 运行时会 looseToNumber 成 number（其 prop 类型仍标 string），这里必须同时容忍两种
function parsePrice(value: string | number): number | null {
  const trimmed = typeof value === 'number' ? String(value) : value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function validateDraft(): ParsedDraft | null {
  clearDraftErrors()
  const input = parsePrice(draft.input)
  const output = parsePrice(draft.output)
  const cacheRead = parsePrice(draft.cacheRead)
  const error = t('pricing.invalidPrice')
  if (input === null) draftErrors.input = error
  if (output === null) draftErrors.output = error
  if (cacheRead === null) draftErrors.cacheRead = error
  return input !== null && output !== null && cacheRead !== null ? { input, output, cacheRead } : null
}

async function savePrice() {
  if (saving.value || !selected.value) return
  const parsed = validateDraft()
  if (!parsed) return

  saving.value = true
  saveError.value = ''
  try {
    await api<PriceRow>('/api/admin/prices', {
      method: 'PUT',
      body: {
        provider_id: selected.value.provider_id,
        model: selected.value.model,
        input_price: parsed.input,
        output_price: parsed.output,
        cache_read_price: parsed.cacheRead,
      },
    })
    await loadPrices()
    toast.add({ title: t('pricing.saved'), color: 'success' })
    editOpen.value = false
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : t('pricing.saveFailed')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UCard :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <div>
        <span class="text-sm font-semibold text-(--ui-text-highlighted)">{{ t('pricing.title') }}</span>
        <p class="mt-0.5 text-xs text-(--ui-text-muted)">{{ t('pricing.subtitle') }}</p>
      </div>
    </template>

    <div class="flex flex-col gap-4 p-4 sm:p-5">
      <div v-if="isLoading" class="flex flex-col gap-3" aria-busy="true">
        <div class="flex flex-col gap-3 sm:flex-row">
          <USkeleton class="h-9 w-full sm:flex-1" />
          <USkeleton class="h-9 w-full sm:w-56" />
        </div>
        <USkeleton v-for="i in 4" :key="i" class="h-12 w-full" />
      </div>

      <div v-else-if="loadError && !loaded" class="flex flex-col items-center gap-3 py-8 text-center">
        <p class="text-sm text-(--ui-text-muted)">{{ loadError }}</p>
        <UButton
          size="sm"
          variant="outline"
          icon="i-lucide-refresh-cw"
          :label="t('pricing.retry')"
          :loading="pricesLoading"
          @click="loadPrices"
        />
      </div>

      <template v-else>
        <UAlert v-if="loadError" color="error" variant="subtle" :title="loadError">
          <template #actions>
            <UButton
              size="xs"
              color="error"
              variant="outline"
              :label="t('pricing.retry')"
              :loading="pricesLoading"
              @click="loadPrices"
            />
          </template>
        </UAlert>

        <div v-if="hasCandidates" class="flex flex-col gap-3 sm:flex-row sm:items-end">
          <UFormField :label="t('pricing.searchLabel')" class="min-w-0 sm:flex-1">
            <UInput
              v-model="searchTerm"
              icon="i-lucide-search"
              :placeholder="t('pricing.searchPlaceholder')"
              class="w-full"
            />
          </UFormField>
          <UFormField :label="t('pricing.providerFilter')" class="w-full sm:w-56">
            <USelect v-model="providerFilter" :items="providerItems" class="w-full" />
          </UFormField>
        </div>

        <UEmpty
          v-if="!hasCandidates"
          icon="i-lucide-coins"
          :title="t('pricing.empty')"
          :description="t('pricing.emptyDesc')"
          variant="naked"
          class="py-8"
        />

        <UEmpty
          v-else-if="isFilteredEmpty"
          icon="i-lucide-search-x"
          :title="t('pricing.filterEmpty')"
          :description="t('pricing.filterEmptyDesc')"
          variant="naked"
          class="py-8"
        />

        <template v-else>
          <div class="hidden overflow-hidden rounded-md border border-(--ui-border) md:block">
            <table class="w-full table-fixed text-sm">
              <caption class="sr-only">{{ t('pricing.title') }}</caption>
              <thead class="bg-(--ui-bg-elevated) text-xs text-(--ui-text-muted)">
                <tr>
                  <th scope="col" class="w-[28%] px-3 py-2.5 text-left font-medium">{{ t('cols.provider') }}</th>
                  <th scope="col" class="w-[19%] px-3 py-2.5 text-right font-medium">{{ t('cols.inputPrice') }}</th>
                  <th scope="col" class="w-[19%] px-3 py-2.5 text-right font-medium">{{ t('cols.outputPrice') }}</th>
                  <th scope="col" class="w-[19%] px-3 py-2.5 text-right font-medium">{{ t('cols.cacheReadPrice') }}</th>
                  <th scope="col" class="w-[15%] px-3 py-2.5 text-right font-medium">{{ t('common.edit') }}</th>
                </tr>
              </thead>
              <tbody v-for="group in filteredGroups" :key="group.model" class="divide-y divide-(--ui-border)">
                <tr class="bg-(--ui-bg-muted)">
                  <th colspan="5" scope="colgroup" class="break-all px-3 py-2 text-left font-mono text-xs font-medium text-(--ui-text-highlighted)">
                    {{ group.model }}
                  </th>
                </tr>
                <tr v-for="row in group.rows" :key="candidateKey(row.model, row.provider_id)" class="bg-(--ui-bg) hover:bg-(--ui-bg-elevated)">
                  <th scope="row" class="px-3 py-3 text-left font-medium text-(--ui-text-highlighted)">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="break-all">{{ row.provider_name }}</span>
                      <UBadge v-if="row.configured" color="neutral" variant="subtle" size="sm">{{ t('pricing.configured') }}</UBadge>
                      <UBadge v-else color="warning" variant="subtle" size="sm">{{ t('pricing.unconfigured') }}</UBadge>
                    </div>
                  </th>
                  <td class="px-3 py-3 text-right tabular-nums text-(--ui-text)">{{ formatPrice(row.input_price) }}</td>
                  <td class="px-3 py-3 text-right tabular-nums text-(--ui-text)">{{ formatPrice(row.output_price) }}</td>
                  <td class="px-3 py-3 text-right tabular-nums text-(--ui-text)">{{ formatPrice(row.cache_read_price) }}</td>
                  <td class="px-3 py-3 text-right">
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="outline"
                      :label="row.configured ? t('common.edit') : t('pricing.configure')"
                      @click="startEdit(row)"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="flex flex-col gap-4 md:hidden">
            <section v-for="group in filteredGroups" :key="group.model" class="flex flex-col gap-2">
              <h3 class="break-all font-mono text-xs font-medium text-(--ui-text-highlighted)">{{ group.model }}</h3>
              <div
                v-for="row in group.rows"
                :key="candidateKey(row.model, row.provider_id)"
                class="flex flex-col gap-3 rounded-md border border-(--ui-border) p-3"
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="flex min-w-0 flex-wrap items-center gap-2">
                    <span class="min-w-0 break-all text-sm font-medium text-(--ui-text-highlighted)">{{ row.provider_name }}</span>
                    <UBadge v-if="row.configured" color="neutral" variant="subtle" size="sm">{{ t('pricing.configured') }}</UBadge>
                    <UBadge v-else color="warning" variant="subtle" size="sm">{{ t('pricing.unconfigured') }}</UBadge>
                  </div>
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="outline"
                    :label="row.configured ? t('common.edit') : t('pricing.configure')"
                    @click="startEdit(row)"
                  />
                </div>
                <dl class="grid grid-cols-3 gap-2 text-xs">
                  <div class="min-w-0">
                    <dt class="text-(--ui-text-muted)">{{ t('cols.inputPrice') }}</dt>
                    <dd class="mt-1 break-words font-medium tabular-nums text-(--ui-text)">{{ formatPrice(row.input_price) }}</dd>
                  </div>
                  <div class="min-w-0">
                    <dt class="text-(--ui-text-muted)">{{ t('cols.outputPrice') }}</dt>
                    <dd class="mt-1 break-words font-medium tabular-nums text-(--ui-text)">{{ formatPrice(row.output_price) }}</dd>
                  </div>
                  <div class="min-w-0">
                    <dt class="text-(--ui-text-muted)">{{ t('cols.cacheReadPrice') }}</dt>
                    <dd class="mt-1 break-words font-medium tabular-nums text-(--ui-text)">{{ formatPrice(row.cache_read_price) }}</dd>
                  </div>
                </dl>
              </div>
            </section>
          </div>
        </template>
      </template>
    </div>
  </UCard>

  <UModal
    v-model:open="editOpen"
    :title="selected?.configured ? t('pricing.editTitle') : t('pricing.configureTitle')"
    :description="t('pricing.subtitle')"
    :dismissible="!saving"
    :close="!saving"
    :ui="{ footer: 'justify-end gap-2' }"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UAlert v-if="saveError" color="error" variant="subtle" :title="saveError" />
        <div class="grid grid-cols-1 gap-3 rounded-md bg-(--ui-bg-muted) p-3 text-sm sm:grid-cols-2">
          <div class="min-w-0">
            <div class="text-xs text-(--ui-text-muted)">{{ t('cols.model') }}</div>
            <div class="mt-1 break-all font-mono text-(--ui-text-highlighted)">{{ selected?.model }}</div>
          </div>
          <div class="min-w-0">
            <div class="text-xs text-(--ui-text-muted)">{{ t('cols.provider') }}</div>
            <div class="mt-1 break-all font-medium text-(--ui-text-highlighted)">{{ selected?.provider_name }}</div>
          </div>
        </div>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <UFormField :label="t('cols.inputPrice')" :required="true" :error="draftErrors.input || undefined">
            <UInput v-model="draft.input" type="number" min="0" step="any" inputmode="decimal" class="w-full" :disabled="saving" />
          </UFormField>
          <UFormField :label="t('cols.outputPrice')" :required="true" :error="draftErrors.output || undefined">
            <UInput v-model="draft.output" type="number" min="0" step="any" inputmode="decimal" class="w-full" :disabled="saving" />
          </UFormField>
          <UFormField :label="t('cols.cacheReadPrice')" :required="true" :error="draftErrors.cacheRead || undefined">
            <UInput v-model="draft.cacheRead" type="number" min="0" step="any" inputmode="decimal" class="w-full" :disabled="saving" />
          </UFormField>
        </div>
      </div>
    </template>
    <template #footer>
      <UButton color="neutral" variant="outline" :label="t('common.cancel')" :disabled="saving" @click="editOpen = false" />
      <UButton :label="t('pricing.save')" :loading="saving" :disabled="saving" @click="savePrice" />
    </template>
  </UModal>
</template>
