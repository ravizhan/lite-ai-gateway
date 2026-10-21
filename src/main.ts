import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ui from '@nuxt/ui/vue-plugin'
import App from './App.vue'
import { router } from './router'
import { i18n } from './lib/i18n'
import './style.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(ui)
app.use(i18n)
app.mount('#app')
