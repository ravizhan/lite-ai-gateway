import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('../pages/login.vue'), meta: { public: true } },
    {
      path: '/',
      component: () => import('../layouts/admin.vue'),
      children: [
        { path: '', name: 'dashboard', component: () => import('../pages/dashboard.vue') },
        { path: 'providers', name: 'providers', component: () => import('../pages/providers.vue') },
        { path: 'models', name: 'models', component: () => import('../pages/models.vue') },
        { path: 'logs', name: 'logs', component: () => import('../pages/logs.vue') },
        { path: 'mcps/servers', name: 'mcp-servers', component: () => import('../pages/mcp/servers.vue') },
        { path: 'mcps/search', name: 'mcp-search', component: () => import('../pages/mcp/search.vue') },
        { path: 'mcps/tools', name: 'mcp-tools', component: () => import('../pages/mcp/tools.vue') },
        { path: 'mcps/groups', name: 'mcp-groups', component: () => import('../pages/mcp/groups.vue') },
        { path: 'mcps/logs', name: 'mcp-logs', component: () => import('../pages/mcp/logs.vue') },
        { path: 'keys', name: 'keys', component: () => import('../pages/keys.vue') },
        { path: 'settings', name: 'settings', component: () => import('../pages/settings.vue') },
      ],
    },
  ],
})

router.beforeEach((to) => {
  const auth = useAuthStore()
  if (!to.meta.public && !auth.token) return { name: 'login' }
})
