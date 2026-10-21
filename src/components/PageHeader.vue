<script setup lang="ts">
/** 统一页头：标题 + 描述 + 右侧操作区 */
defineProps<{ title: string; description?: string }>()
</script>

<template>
  <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
    <div class="min-w-0">
      <h1 class="text-lg font-semibold tracking-tight text-(--ui-text-highlighted)">{{ title }}</h1>
      <p v-if="description" class="mt-0.5 text-sm text-(--ui-text-muted)">{{ description }}</p>
    </div>
    <div v-if="$slots.default" class="flex shrink-0 flex-wrap items-center gap-2">
      <slot />
    </div>
  </div>
</template>
