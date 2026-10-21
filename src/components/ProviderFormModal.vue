<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { api } from '../lib/api'
import type { ProviderRow } from '../../shared/api'
import { useI18n } from 'vue-i18n'

type ProviderType = ProviderRow['type']

const props = defineProps<{ provider?: ProviderRow | null }>()
const emit = defineEmits<{ saved: [] }>()
const open = defineModel<boolean>('open', { default: false })

const toast = useToast()
const { t } = useI18n()
const saving = ref(false)
const form = reactive({
  type: 'llm' as ProviderType,
  name: '',
  base_url: '',
  api_key: '',
  supports_responses: false,
  timeout_ms: 0,
  max_concurrency: 0,
  transform_code: '',
  enabled: true,
})
const errors = reactive({ name: '', base_url: '', api_key: '', transform_code: '' })
const typeOptions = computed(() => [
  { label: t('providerForm.llm'), value: 'llm' as ProviderType },
  { label: t('providerForm.embedding'), value: 'embedding' as ProviderType },
])
const isEmbedding = computed(() => form.type === 'embedding')

watch(open, (v) => {
  if (!v) return
  form.type = props.provider?.type === 'embedding' ? 'embedding' : 'llm'
  form.name = props.provider?.name ?? ''
  form.base_url = props.provider?.base_url ?? ''
  form.api_key = ''
  form.supports_responses = (props.provider?.supports_responses ?? 0) === 1
  form.timeout_ms = props.provider?.timeout_ms ?? 0
  form.max_concurrency = props.provider?.max_concurrency ?? 0
  form.transform_code = props.provider?.transform_code ?? ''
  form.enabled = (props.provider?.enabled ?? 1) === 1
  errors.name = errors.base_url = errors.api_key = errors.transform_code = ''
})

function validate(): boolean {
  errors.name = form.name.trim() ? '' : t('validation.nameRequired')
  errors.base_url = form.base_url.trim() ? '' : t('validation.baseUrlRequired')
  errors.api_key = !props.provider && !form.api_key.trim() ? t('validation.apiKeyRequired') : ''
  return !errors.name && !errors.base_url && !errors.api_key
}

async function submit() {
  if (!validate()) return
  errors.transform_code = ''
  saving.value = true
  try {
    const body: Record<string, unknown> = {
      type: form.type,
      name: form.name.trim(),
      base_url: form.base_url.trim(),
      supports_responses: isEmbedding.value ? 0 : form.supports_responses ? 1 : 0,
      timeout_ms: Number(form.timeout_ms) || 0,
      max_concurrency: Number(form.max_concurrency) || 0,
      transform_code: isEmbedding.value ? form.transform_code : '',
    }
    if (props.provider) {
      body.enabled = form.enabled ? 1 : 0
      if (form.api_key.trim()) body.api_key = form.api_key.trim()
      await api(`/api/admin/providers/${props.provider.id}`, { method: 'PUT', body })
      toast.add({ title: t('providerForm.updated'), color: 'success' })
    } else {
      body.api_key = form.api_key.trim()
      await api('/api/admin/providers', { method: 'POST', body })
      toast.add({ title: t('providerForm.created'), color: 'success' })
    }
    open.value = false
    emit('saved')
  } catch (e) {
    const message = e instanceof Error ? e.message : t('providerForm.saveFailed')
    if (message.includes('transform_code')) errors.transform_code = message
    toast.add({ title: message, color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="props.provider ? t('providerForm.editTitle') : t('providerForm.addTitle')"
    :description="t('providerForm.description')"
    :ui="{ content: 'sm:max-w-2xl', footer: 'justify-end gap-2' }"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UFormField :label="t('providerForm.type')">
          <UTabs
            v-model="form.type"
            :items="typeOptions"
            :content="false"
            class="w-full"
            :ui="{ list: 'w-full', trigger: 'flex-1 justify-center' }"
          />
        </UFormField>
        <UFormField :label="t('common.name')" :required="true" :error="errors.name || undefined">
          <UInput v-model="form.name" placeholder="e.g. DeepSeek" class="w-full" />
        </UFormField>
        <UFormField :label="t('providerForm.baseUrl')" :required="true" :error="errors.base_url || undefined">
          <UInput v-model="form.base_url" placeholder="https://api.deepseek.com" class="w-full" />
        </UFormField>
        <UFormField
          :label="t('providerForm.apiKey')"
          :required="!props.provider"
          :error="errors.api_key || undefined"
          :help="props.provider ? t('providerForm.keepKey') : undefined"
        >
          <UInput v-model="form.api_key" type="password" placeholder="sk-..." class="w-full" />
        </UFormField>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <UFormField :label="t('providerForm.timeout')" :help="t('providerForm.timeoutHelp')">
            <UInput v-model.number="form.timeout_ms" type="number" min="0" class="w-full" />
          </UFormField>
          <UFormField :label="t('providerForm.maxConcurrency')" :help="t('providerForm.maxConcurrencyHelp')">
            <UInput v-model.number="form.max_concurrency" type="number" min="0" step="1" class="w-full" />
          </UFormField>
        </div>
        <UFormField
          v-if="isEmbedding"
          :label="t('providerForm.transformCode')"
          :help="t('providerForm.transformCodeHelp')"
          :error="errors.transform_code || undefined"
        >
          <UTextarea v-model="form.transform_code" :rows="6" class="w-full font-mono text-sm" />
        </UFormField>
        <UFormField v-else :label="t('providerForm.supportsResponses')" :help="t('providerForm.supportsResponsesHelp')">
          <USwitch v-model="form.supports_responses" />
        </UFormField>
        <UFormField v-if="props.provider" :label="t('common.enabled')">
          <USwitch v-model="form.enabled" />
        </UFormField>
      </div>
    </template>
    <template #footer>
      <UButton color="neutral" variant="outline" :label="t('common.cancel')" @click="open = false" />
      <UButton :loading="saving" :label="t('common.save')" @click="submit" />
    </template>
  </UModal>
</template>
