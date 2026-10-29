<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '../lib/api'
import { exposedDefinitionText, loadO200kCounter, type McpPromptEditTarget } from '../lib/mcp-prompt'

const props = defineProps<{ target: McpPromptEditTarget | null }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [] }>()

const { t } = useI18n()
const toast = useToast()
const text = ref('')
const saving = ref(false)
const restoring = ref(false)
const counter = ref<((value: string) => number) | null>(null)

watch(open, (v) => {
  if (!v || !props.target) return
  text.value = props.target.prompt
  if (!counter.value) {
    void loadO200kCounter().then((c) => {
      counter.value = c
    })
  }
})

const dirty = computed(() => props.target !== null && text.value !== props.target.prompt)
/** 保存后是否形成覆盖（与默认一致时后端自动清除覆盖） */
const willOverride = computed(() => props.target !== null && text.value !== props.target.defaultPrompt)

/** 编辑中文本的实时 token 数（按暴露定义整体统计，与列表页口径一致） */
const draftTokens = computed(() => {
  if (!counter.value || !props.target) return null
  return counter.value(
    exposedDefinitionText(props.target.serverName, props.target, text.value, willOverride.value, props.target.exposedToolName),
  )
})
const defaultTokens = computed(() => {
  if (!counter.value || !props.target) return null
  return counter.value(
    exposedDefinitionText(props.target.serverName, props.target, props.target.defaultPrompt, false, props.target.exposedToolName),
  )
})

async function save() {
  const target = props.target
  if (!target) return
  saving.value = true
  try {
    await api('/api/admin/mcp/prompts', {
      method: 'PUT',
      body: { server_id: target.serverId, kind: target.kind, name: target.name, prompt: text.value },
    })
    toast.add({ title: t('mcpTools.saved'), color: 'success' })
    emit('saved')
  } catch (e) {
    toast.add({ title: e instanceof Error ? e.message : t('mcpTools.saveFailed'), color: 'error' })
  } finally {
    saving.value = false
  }
}

async function restore() {
  const target = props.target
  if (!target) return
  restoring.value = true
  try {
    await api('/api/admin/mcp/prompts', {
      method: 'DELETE',
      body: { server_id: target.serverId, kind: target.kind, name: target.name },
    })
    toast.add({ title: t('mcpTools.restored'), color: 'success' })
    emit('saved')
  } catch (e) {
    toast.add({ title: e instanceof Error ? e.message : t('mcpTools.restoreFailed'), color: 'error' })
  } finally {
    restoring.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('mcpTools.editTitle', { name: props.target?.name ?? '' })"
    :description="t('mcpTools.editDescription')"
    :ui="{ content: 'sm:max-w-2xl', footer: 'justify-between gap-2' }"
  >
    <template #body>
      <div v-if="props.target" class="flex flex-col gap-4">
        <div class="flex flex-wrap items-center gap-2 text-sm text-(--ui-text-muted)">
          <UBadge color="neutral" variant="subtle">{{ t(`mcpTools.kind_${props.target.kind}`) }}</UBadge>
          <span class="font-medium text-(--ui-text-highlighted)">{{ props.target.serverName }}</span>
          <UBadge v-if="props.target.overridden" color="primary" variant="subtle">{{ t('mcpTools.custom') }}</UBadge>
        </div>

        <UFormField
          :label="t('mcpTools.prompt')"
          :help="
            draftTokens !== null && defaultTokens !== null
              ? t('mcpTools.tokenStat', { current: draftTokens.toLocaleString(), default: defaultTokens.toLocaleString() })
              : undefined
          "
        >
          <UTextarea v-model="text" autoresize :rows="6" class="w-full font-mono text-sm" />
        </UFormField>

        <UFormField :label="t('mcpTools.defaultPrompt')">
          <p class="rounded-md bg-(--ui-bg-muted) px-2.5 py-2 text-sm whitespace-pre-wrap text-(--ui-text-muted)">
            {{ props.target.defaultPrompt || t('common.none') }}
          </p>
        </UFormField>
      </div>
    </template>
    <template #footer>
      <UButton
        v-if="props.target?.overridden"
        color="neutral"
        variant="outline"
        icon="i-lucide-rotate-ccw"
        :label="t('mcpTools.restoreDefault')"
        :loading="restoring"
        @click="restore"
      />
      <span v-else />
      <div class="flex items-center gap-2">
        <UButton color="neutral" variant="outline" :label="t('common.cancel')" @click="open = false" />
        <UButton :label="t('common.save')" :loading="saving" :disabled="!dirty" @click="save" />
      </div>
    </template>
  </UModal>
</template>
