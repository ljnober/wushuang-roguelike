/**
 * 应用入口（ARCHITECTURE §6.5）。
 *
 * 批次 A 单独构建时 ./registration/*.ts 无匹配文件，import.meta.glob 返回空对象，
 * 应用以 headless 模式启动；批次 B/C 侧载的注册文件会被自动执行。
 */
import { createApp, type App } from './app/App';
// 加载顺序：style.css（全局骨架 + 冻结契约）先，ui/styles/index.css（分域样式）后，
// 使后者在同优先级下覆盖前者的历史硬编码值。
import './style.css';
import './ui/styles/index.css';

const app: App = createApp();

const registrars = import.meta.glob('./registration/*.ts', { eager: true }) as Record<
  string,
  { register(app: App): void }
>;

for (const key of Object.keys(registrars)) {
  registrars[key].register(app);
}

app.start();
