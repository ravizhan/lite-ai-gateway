import { defineStore } from 'pinia'
import { ref } from 'vue'

const STORAGE_KEY = 'lite-ai-gateway:token'

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string>(localStorage.getItem(STORAGE_KEY) ?? '')

  function login(t: string) {
    token.value = t
    localStorage.setItem(STORAGE_KEY, t)
  }
  function logout() {
    token.value = ''
    localStorage.removeItem(STORAGE_KEY)
  }
  return { token, login, logout }
})
