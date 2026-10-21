import { reactive, ref } from 'vue'
import { api } from '../lib/api'
import type { Paged } from '../../shared/api'

/** 通用服务端分页列表：管理 page/pageSize/loading/filters 并拉取 { rows, total }；filters 值为字符串（USelect/UInput 的 model），api 层负责 String() 化 */
export function usePagedList<T>(path: string, initialFilters: Record<string, string | undefined> = {}) {
  const rows = ref<T[]>([]) as Ref<T[]>
  const total = ref(0)
  const page = ref(1)
  const pageSize = ref(20)
  const loading = ref(false)
  const filters = reactive({ ...initialFilters }) as Record<string, string | undefined>

  async function load() {
    loading.value = true
    try {
      const data = await api<Paged<T>>(path, {
        query: { ...filters, page: page.value, pageSize: pageSize.value },
      })
      rows.value = data.rows
      total.value = data.total
    } finally {
      loading.value = false
    }
  }

  function search() {
    page.value = 1
    void load()
  }

  return { rows, total, page, pageSize, loading, filters, load, search }
}
