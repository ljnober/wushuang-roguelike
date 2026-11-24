/// <reference types="vite/client" />
/// <reference types="vitest/globals" />

/** 由 vite.config.ts 的 define 注入：?debug=1 时为 true。 */
declare const __DEBUG__: boolean;

interface ImportMeta {
  /** vite/client 已提供完整重载；此处显式声明本工程使用的 eager glob 形态。 */
  glob<T = unknown>(
    pattern: string,
    options: { eager: true; import?: string; query?: string },
  ): Record<string, T>;
}
