import { reactive, ref } from 'vue'
import { api } from '../lib/api'
import type { Paged } from '../../shared/api'

/**
 * 通用服务端分页列表：管理 page/pageSize/loading/filters 并拉取 { rows, total }；filters 值为字符串（USelect/UInput 的 model），api 层负责 String() 化。
 * `load({ silent: true })` 用于后台刷新：不切换 loading（表格不闪骨架）；拉取失败一律保留现有数据。
 */
export function usePagedList<T>(path: string, initialFilters: Record<string, string | undefined> = {}) {
  const rows = ref<T[]>([]) as Ref<T[]>
  const total = ref(0)
  const page = ref(1)
  const pageSize = ref(20)
  const loading = ref(false)
  const filters = reactive({ ...initialFilters }) as Record<string, string | undefined>

  async function load(options: { silent?: boolean } = {}) {
    if (!options.silent) loading.value = true
    try {
      const data = await api<Paged<T>>(path, {
        query: { ...filters, page: page.value, pageSize: pageSize.value },
      })
      rows.value = data.rows
      total.value = data.total
    } catch {
      // 拉取失败保留当前页数据，下一次筛选/刷新再试
    } finally {
      if (!options.silent) loading.value = false
    }
  }

  function search() {
    page.value = 1
    void load()
  }

  return { rows, total, page, pageSize, loading, filters, load, search }
}
