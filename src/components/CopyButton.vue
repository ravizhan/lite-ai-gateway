<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ text: string }>()
const copied = ref(false)
const toast = useToast()
const { t } = useI18n()

async function copy() {
  try {
    await navigator.clipboard.writeText(props.text)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    toast.add({ title: t('common.copyFailed'), color: 'error' })
  }
}
</script>

<template>
  <UTooltip :text="copied ? t('common.copied') : t('common.copy')">
    <UButton
      :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
      :color="copied ? 'success' : 'neutral'"
      variant="ghost"
      size="xs"
      :aria-label="t('common.copyToClipboard')"
      @click="copy"
    />
  </UTooltip>
</template>
