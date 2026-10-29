<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { VueDraggable } from 'vue-draggable-plus'
import AffinityRuleEditor from '@/components/AffinityRuleEditor.vue'
import { api } from '@/lib/api'
import {
  DEFAULT_AFFINITY_SETTINGS,
  DEFAULT_GATEWAY_SETTINGS,
  type AffinityRule,
  type GatewaySettings,
} from '../../shared/api'

const { t } = useI18n()
const toast = useToast()

function cloneRule(rule: AffinityRule): AffinityRule {
  return {
    name: rule.name,
    enabled: rule.enabled,
    modelPattern: rule.modelPattern,
    pathPattern: rule.pathPattern,
    userAgent: rule.userAgent,
    valuePattern: rule.valuePattern,
    ttlSeconds: rule.ttlSeconds,
    keySources: rule.keySources.map((source) => ({ type: source.type, key: source.key })),
  }
}

function cloneSettings(settings: GatewaySettings): GatewaySettings {
  return {
    affinity: {
      enabled: settings.affinity.enabled,
      ttlSeconds: settings.affinity.ttlSeconds,
      rules: settings.affinity.rules.map(cloneRule),
    },
  }
}

const ruleIds = new WeakMap<AffinityRule, string>()
let ruleIdCounter = 0

function ruleId(rule: AffinityRule) {
  const existing = ruleIds.get(rule)
  if (existing) return existing
  const id = `rule-${++ruleIdCounter}`
  ruleIds.set(rule, id)
  return id
}

function applySettings(next: GatewaySettings) {
  draft.affinity.enabled = next.affinity.enabled
  draft.affinity.ttlSeconds = next.affinity.ttlSeconds
  draft.affinity.rules.splice(0, draft.affinity.rules.length, ...next.affinity.rules.map(cloneRule))
}

const draft = reactive<GatewaySettings>(cloneSettings(DEFAULT_GATEWAY_SETTINGS))
const loading = ref(true)
const loaded = ref(false)
const loadError = ref('')
const saving = ref(false)
const saveError = ref('')

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

async function loadSettings() {
  loading.value = true
  loadError.value = ''
  try {
    const next = await api<GatewaySettings>('/api/admin/settings')
    applySettings(next)
    loaded.value = true
  } catch (error) {
    loadError.value = errorMessage(error, t('settings.loadFailed'))
  } finally {
    loading.value = false
  }
}

function nextRuleName() {
  const names = new Set(draft.affinity.rules.map((rule) => rule.name))
  let index = 1
  while (names.has(`rule-${index}`)) index += 1
  return `rule-${index}`
}

function addRule() {
  const defaultRule = DEFAULT_AFFINITY_SETTINGS.rules[0]
  if (!defaultRule) return
  const rule = cloneRule(defaultRule)
  rule.name = nextRuleName()
  draft.affinity.rules.push(rule)
}

function removeRule(index: number) {
  draft.affinity.rules.splice(index, 1)
}

function moveRule(index: number, direction: 'up' | 'down') {
  const nextIndex = direction === 'up' ? index - 1 : index + 1
  if (nextIndex < 0 || nextIndex >= draft.affinity.rules.length) return
  const [rule] = draft.affinity.rules.splice(index, 1)
  if (rule) draft.affinity.rules.splice(nextIndex, 0, rule)
}

async function saveSettings() {
  if (saving.value || !loaded.value) return
  saving.value = true
  saveError.value = ''
  try {
    const saved = await api<GatewaySettings>('/api/admin/settings', {
      method: 'PUT',
      body: cloneSettings(draft),
    })
    if (saved?.affinity) applySettings(saved)
    toast.add({ title: t('settings.saved'), color: 'success' })
  } catch (error) {
    saveError.value = errorMessage(error, t('settings.saveFailed'))
    toast.add({ title: saveError.value, color: 'error' })
  } finally {
    saving.value = false
  }
}

onMounted(loadSettings)
</script>

<template>
  <PageHeader :title="t('settings.title')" :description="t('settings.description')">
    <UButton
      :label="t('settings.save')"
      :loading="saving"
      :disabled="loading || !loaded"
      @click="saveSettings"
    />
  </PageHeader>

  <div v-if="loading && !loaded" class="flex flex-col gap-6">
    <UCard>
      <div class="flex flex-col gap-4">
        <USkeleton class="h-5 w-44" />
        <USkeleton class="h-4 w-3/4" />
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <USkeleton class="h-10 w-full" />
          <USkeleton class="h-10 w-full" />
        </div>
      </div>
    </UCard>
    <UCard>
      <div class="flex flex-col gap-4">
        <USkeleton class="h-5 w-40" />
        <USkeleton class="h-4 w-2/3" />
        <USkeleton class="h-56 w-full" />
      </div>
    </UCard>
  </div>

  <div v-else-if="!loaded" class="flex flex-col gap-3">
    <UAlert
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('settings.loadFailed')"
      :description="loadError"
    />
    <div>
      <UButton icon="i-lucide-refresh-cw" :label="t('settings.retry')" :loading="loading" @click="loadSettings" />
    </div>
  </div>

  <template v-else>
    <UAlert
      v-if="loadError"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('settings.loadFailed')"
      :description="loadError"
    >
      <template #actions>
        <UButton size="xs" color="warning" variant="outline" :label="t('settings.retry')" :loading="loading" @click="loadSettings" />
      </template>
    </UAlert>

    <UAlert
      v-if="saveError"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('settings.saveFailed')"
      :description="saveError"
    />

    <fieldset :disabled="saving" class="flex flex-col gap-6">
      <UCard :title="t('settings.affinity.title')" :description="t('settings.affinity.description')">
        <div class="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <UFormField :label="t('settings.affinity.enabled')" :help="t('settings.affinity.enabledHelp')">
            <USwitch v-model="draft.affinity.enabled" :disabled="saving" />
          </UFormField>
          <UFormField :label="t('settings.affinity.ttl')" :help="t('settings.affinity.ttlHelp')">
            <div class="flex items-center gap-2">
              <UInput v-model.number="draft.affinity.ttlSeconds" type="number" min="1" step="1" class="w-full" />
              <span class="shrink-0 text-sm text-(--ui-text-muted)">{{ t('settings.affinity.seconds') }}</span>
            </div>
          </UFormField>
        </div>
      </UCard>

      <UCard>
        <template #header>
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="text-base font-semibold text-(--ui-text-highlighted)">{{ t('settings.rules.title') }}</h2>
              <p class="mt-1 text-sm text-(--ui-text-muted)">{{ t('settings.rules.description') }}</p>
            </div>
            <UButton
              icon="i-lucide-plus"
              color="neutral"
              variant="outline"
              :label="t('settings.rules.add')"
              :disabled="saving"
              @click="addRule"
            />
          </div>
        </template>

        <div class="flex flex-col gap-5">
          <UAlert
            color="info"
            variant="subtle"
            icon="i-lucide-list-tree"
            :description="t('settings.rules.orderHelp')"
          />

          <VueDraggable
            v-if="draft.affinity.rules.length"
            v-model="draft.affinity.rules"
            handle=".rule-drag-handle"
            :animation="150"
            :disabled="saving"
            class="flex flex-col gap-4"
          >
            <AffinityRuleEditor
              v-for="(rule, index) in draft.affinity.rules"
              :key="ruleId(rule)"
              v-model:rule="draft.affinity.rules[index]"
              :index="index"
              :total="draft.affinity.rules.length"
              :draggable-disabled="saving"
              @remove="removeRule(index)"
              @move="moveRule(index, $event)"
            />
          </VueDraggable>

          <UEmpty
            v-else
            icon="i-lucide-route"
            :title="t('settings.rules.empty')"
            variant="naked"
            class="py-6"
          />
        </div>
      </UCard>
    </fieldset>
  </template>
</template>
