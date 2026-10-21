/** vue-i18n 实例：中英双语；语言持久化到 localStorage，未设置时按浏览器语言探测 */
import { createI18n } from 'vue-i18n'
import en from '../locales/en.json'
import zhCN from '../locales/zh-CN.json'

const STORAGE_KEY = 'lite-ai-gateway:locale'
export type AppLocale = 'en' | 'zh-CN'

function detectLocale(): AppLocale {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved === 'en' || saved === 'zh-CN') return saved
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

export const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: 'en',
  messages: { en, 'zh-CN': zhCN },
})

/** 切换语言并持久化（USelect 回调为 string，运行时兜底为 'en'） */
export function setLocale(locale: AppLocale | string): void {
  const next: AppLocale = locale === 'zh-CN' ? 'zh-CN' : 'en'
  i18n.global.locale.value = next
  localStorage.setItem(STORAGE_KEY, next)
}
