<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

/** 统一删除确认弹窗：危险操作前二次确认 */
const { t } = useI18n()
const props = withDefaults(
  defineProps<{
    /** 弹窗标题，如 `Delete provider` */
    title: string
    /** 被删除对象名（加粗高亮展示） */
    name?: string
    /** 附加后果说明，如“its models and routes will also be removed” */
    detail?: string
    loading?: boolean
  }>(),
  { name: '', detail: '', loading: false },
)
const emit = defineEmits<{ confirm: [] }>()
const open = defineModel<boolean>('open', { default: false })

const description = computed(() => {
  if (!props.detail) return t('common.cannotUndo')
  return props.detail.replace(/\.+$/, '') + '.'
})
</script>

<template>
  <UModal v-model:open="open" :title="title" :description="description" :ui="{ footer: 'justify-end gap-2' }">
    <template #body>
      <div class="flex items-start gap-3">
        <div class="flex size-9 shrink-0 items-center justify-center rounded-full bg-(--ui-error)/10">
          <UIcon name="i-lucide-triangle-alert" class="size-4.5 text-(--ui-error)" />
        </div>
        <p class="min-w-0 pt-1.5 text-sm text-(--ui-text)">
          {{ t('common.confirmDelete', { name: name || t('common.thisItem') }) }}
        </p>
      </div>
    </template>
    <template #footer>
      <UButton color="neutral" variant="outline" :label="t('common.cancel')" @click="open = false" />
      <UButton color="error" :label="t('common.delete')" :loading="loading" @click="emit('confirm')" />
    </template>
  </UModal>
</template>
