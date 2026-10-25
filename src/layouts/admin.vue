<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { NavigationMenuItem } from '@nuxt/ui'
import { api } from '../lib/api'
import { setLocale, type AppLocale } from '../lib/i18n'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '../stores/auth'
import type { AdminInfo } from '../../shared/api'

const auth = useAuthStore()
const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const info = ref<AdminInfo | null>(null)
const mobileNavOpen = ref(false)

const localeOptions = [
  { label: 'English', value: 'en' },
  { label: '中文', value: 'zh-CN' },
]

function changeLocale(value: string | AppLocale) {
  setLocale(value)
}

onMounted(async () => {
  try {
    info.value = await api<AdminInfo>('/api/admin/info')
  } catch {
    // token 失效时 api 层已处理跳转
  }
})

watch(() => route.fullPath, () => {
  mobileNavOpen.value = false
})

function logout() {
  auth.logout()
  router.push('/login')
}

/** 当前路由位于 MCP 分组下时默认展开 */
const mcpActive = computed(() => route.path.startsWith('/mcps'))

const items = computed<NavigationMenuItem[][]>(() => [
  [
    { label: t('nav.dashboard'), icon: 'i-lucide-layout-dashboard', to: '/', exact: true },
    { label: t('nav.providers'), icon: 'i-lucide-cloud', to: '/providers' },
    { label: t('nav.models'), icon: 'i-lucide-coins', to: '/models' },
    { label: t('nav.logs'), icon: 'i-lucide-scroll-text', to: '/logs' },
    {
      label: t('nav.mcp'),
      icon: 'i-lucide-blocks',
      defaultOpen: mcpActive.value,
      children: [
        { label: t('nav.mcpServers'), to: '/mcps/servers' },
        { label: t('nav.mcpSearch'), to: '/mcps/search' },
        { label: t('nav.mcpTools'), to: '/mcps/tools' },
        { label: t('nav.mcpGroups'), to: '/mcps/groups' },
        { label: t('nav.mcpLogs'), to: '/mcps/logs' },
      ],
    },
    { label: t('nav.apiKeys'), icon: 'i-lucide-key-round', to: '/keys' },
    { label: t('nav.settings'), icon: 'i-lucide-settings', to: '/settings' },
  ],
])
</script>

<template>
  <div class="isolate flex h-screen overflow-hidden bg-(--ui-bg)">
    <!-- 桌面端侧边栏 -->
    <aside class="hidden w-60 shrink-0 flex-col border-r border-(--ui-border) bg-(--ui-bg-muted)/30 md:flex">
      <div class="flex h-14 shrink-0 items-center gap-2.5 border-b border-(--ui-border) px-4">
        <span class="flex size-7 shrink-0 items-center justify-center rounded-md bg-(--ui-primary) text-(--ui-bg)">
          <UIcon name="i-lucide-zap" class="size-4" />
        </span>
        <div class="flex min-w-0 items-baseline gap-1.5">
          <span class="truncate text-sm font-semibold tracking-tight text-(--ui-text-highlighted)">Lite AI Gateway</span>
          <span v-if="info" class="shrink-0 text-[11px] text-(--ui-text-dimmed)">v{{ info.version }}</span>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
        <UNavigationMenu :items="items" orientation="vertical" />
      </div>

      <div class="shrink-0 border-t border-(--ui-border) px-4 py-3">
        <div class="flex items-center gap-2">
          <RuntimeBadge :runtime="info?.runtime" :db="info?.db" />
        </div>
        <p class="mt-2 text-[11px] text-(--ui-text-dimmed)">{{ t('nav.adminConsole') }}</p>
      </div>
    </aside>

    <!-- 移动端抽屉导航 -->
    <USlideover v-model:open="mobileNavOpen" side="left" title="Lite AI Gateway" class="md:hidden">
      <template #body>
        <UNavigationMenu :items="items" orientation="vertical" />
      </template>
      <template #footer>
        <div class="flex items-center gap-2">
          <RuntimeBadge :runtime="info?.runtime" :db="info?.db" :version="info?.version" />
        </div>
      </template>
    </USlideover>

    <!-- 主区域 -->
    <div class="flex min-w-0 flex-1 flex-col">
      <header
        class="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-(--ui-border) bg-(--ui-bg)/90 px-4 backdrop-blur"
      >
        <div class="flex min-w-0 items-center gap-1.5">
          <UButton
            icon="i-lucide-menu"
            color="neutral"
            variant="ghost"
            :aria-label="t('nav.openNavigation')"
            class="md:hidden"
            @click="mobileNavOpen = true"
          />
          <span class="truncate text-sm font-medium text-(--ui-text-highlighted) md:hidden">Lite AI Gateway</span>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <USelect v-model="locale" :items="localeOptions" class="w-[92px]" size="sm" @update:model-value="changeLocale" />
          <UColorModeSelect class="w-28" size="sm" />
          <UTooltip :text="t('nav.signOut')">
            <UButton icon="i-lucide-log-out" color="neutral" variant="ghost" :aria-label="t('nav.signOut')" @click="logout" />
          </UTooltip>
        </div>
      </header>

      <main class="min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto flex max-w-7xl flex-col gap-6 p-4 md:p-6">
          <RouterView />
        </div>
      </main>
    </div>
  </div>
</template>
