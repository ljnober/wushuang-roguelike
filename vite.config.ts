import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Vite + Vitest 统一配置。
 *
 * - 测试环境默认 node（确定性/纯逻辑测试不需要 DOM）。
 * - 需要 DOM 的测试：把 environment 改为 'jsdom'，或在单个测试文件顶部写
 *   `// @vitest-environment jsdom`（jsdom 已作为 devDependency 安装）。
 * - `?debug=1` 通过 define 暴露为编译期常量 __DEBUG__，业务代码直接读取即可，
 *   在 node 测试环境下 typeof location === 'undefined' 保证求值安全。
 */
export default defineConfig({
  base: './',
  define: {
    __DEBUG__:
      "typeof location !== 'undefined' && new URLSearchParams(location.search).get('debug') === '1'",
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/__tests__/*.test.ts'],
    clearMocks: true,
  },
});
