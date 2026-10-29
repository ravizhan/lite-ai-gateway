<script setup lang="ts">
import { useI18n } from 'vue-i18n'

/** 统一破坏性操作确认弹窗，默认使用删除文案 */
const { t } = useI18n()
const props = withDefaults(
  defineProps<{
    /** 弹窗标题，如 `Delete provider` */
    title: string
    /** 被删除对象名（加粗高亮展示） */
    name?: string
    /** 附加后果说明，如“its models and routes will also be removed” */
    detail?: string
    /** 覆盖等非删除操作的确认正文 */
    message?: string
    confirmLabel?: string
    loading?: boolean
  }>(),
  { name: '', detail: '', message: undefined, confirmLabel: undefined, loading: false },
)
const emit = defineEmits<{ confirm: [] }>()
const open = defineModel<boolean>('open', { default: false })

const description = computed(() => (props.detail ? `${props.detail}.` : t('common.cannotUndo')))
</script>

<template>
  <UModal v-model:open="open" :title="title" :description="description" :ui="{ footer: 'justify-end gap-2' }">
    <template #body>
      <div class="flex items-start gap-3">
        <div class="flex size-9 shrink-0 items-center justify-center rounded-full bg-(--ui-error)/10">
          <UIcon name="i-lucide-triangle-alert" class="size-4.5 text-(--ui-error)" />
        </div>
        <p class="min-w-0 pt-1.5 text-sm text-(--ui-text)">
          {{ message ?? t('common.confirmDelete', { name: name || t('common.thisItem') }) }}
        </p>
      </div>
    </template>
    <template #footer>
      <UButton color="neutral" variant="outline" :label="t('common.cancel')" @click="open = false" />
      <UButton color="error" :label="confirmLabel ?? t('common.delete')" :loading="loading" @click="emit('confirm')" />
    </template>
  </UModal>
</template>
