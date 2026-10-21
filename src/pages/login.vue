<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../lib/api'
import { useAuthStore } from '../stores/auth'
import { useI18n } from 'vue-i18n'

const auth = useAuthStore()
const { t } = useI18n()
const router = useRouter()
const token = ref('')
const loading = ref(false)
const error = ref('')

async function submit() {
  if (!token.value.trim() || loading.value) return
  loading.value = true
  error.value = ''
  // 先用 token 探一次 admin 接口，通过再持久化
  auth.login(token.value.trim())
  try {
    await api('/api/admin/info')
    router.push('/')
  } catch (e) {
    auth.logout()
    error.value = e instanceof Error && e.message !== 'unauthorized' ? e.message : t('login.invalidToken')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="relative flex min-h-screen items-center justify-center overflow-hidden bg-(--ui-bg) p-4">
    <!-- 背景装饰：柔和主色光晕 -->
    <div
      aria-hidden="true"
      class="pointer-events-none absolute left-1/2 top-0 h-[480px] w-[720px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-(--ui-primary)/10 blur-3xl"
    />

    <div class="relative w-full max-w-sm">
      <div class="mb-8 flex flex-col items-center gap-3 text-center">
        <span class="flex size-11 items-center justify-center rounded-xl bg-(--ui-primary) text-(--ui-bg)">
          <UIcon name="i-lucide-zap" class="size-5" />
        </span>
        <div>
          <h1 class="text-lg font-semibold tracking-tight text-(--ui-text-highlighted)">Lite AI Gateway</h1>
          <p class="mt-1 text-sm text-(--ui-text-muted)">{{ t('login.subtitle') }}</p>
        </div>
      </div>

      <UCard>
        <form class="flex flex-col gap-4" @submit.prevent="submit">
          <UFormField :label="t('login.adminToken')" :error="error || undefined">
            <UInput
              v-model="token"
              type="password"
              placeholder="ADMIN_TOKEN"
              icon="i-lucide-key-round"
              autofocus
              class="w-full"
              @update:model-value="error = ''"
            />
          </UFormField>
          <UButton type="submit" block :loading="loading" :disabled="!token.trim()">{{ t('login.signIn') }}</UButton>
        </form>
      </UCard>

      <div class="mt-6 flex justify-center">
        <UColorModeButton size="sm" />
      </div>
    </div>
  </div>
</template>
