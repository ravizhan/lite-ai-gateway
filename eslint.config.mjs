import js from '@eslint/js'
import vue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default [
  { ignores: ['dist/**', 'dist-bundle/**', 'node_modules/**', '.wrangler/**', 'src/auto-imports.d.ts', 'src/components.d.ts', 'worker-configuration.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    // 浏览器全局（src/ 前端代码）
    files: ['src/**/*.{ts,vue}'],
    languageOptions: {
      globals: {
        window: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        location: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Event: 'readonly',
      },
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
  {
    // 页面/布局组件按文件路由命名，单名是约定；auto-import 的 composable 对 eslint 不可见
    files: ['src/pages/**/*.vue', 'src/layouts/**/*.vue'],
    rules: { 'vue/multi-word-component-names': 'off' },
  },
  {
    files: ['src/**/*.{ts,vue}'],
    rules: { 'no-undef': 'off' },
  },
  prettier,
]
