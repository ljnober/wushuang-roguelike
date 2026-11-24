# 《无双》局域网访问说明（E3）

> 适用范围：开发服务器（`npm run dev` / `npm run dev:lan`）与预览服务器（`npm run preview` / `npm run preview:lan`）。
> 本文只解决「为什么网址不能让别的 PC 访问」这一网络层问题，与游戏逻辑无关。

## 1. 根因

Vite 默认只绑定 `127.0.0.1`（localhost），**仅接受本机回环连接**。其他 PC 向本机发起的 TCP 连接会被直接拒绝，因此浏览器显示无法访问。

本项目已在 `vite.config.ts` 中固定：

- `server.host = '0.0.0.0'`：dev server 监听全部网卡，局域网可达；
- `server.port = 5173`、`strictPort = false`：端口被占用时自动顺延（此时需以终端实际打印的端口为准）；
- `server.hmr.clientPort = 5173`：跨 PC 访问时 HMR 热更新使用同一端口，避免代理/端口推断导致连接错误；
- `preview.host = '0.0.0.0'`、`preview.port = 4173`：生产预览同样可被局域网访问。

## 2. 正确的访问地址

在**同一局域网内的另一台 PC** 浏览器打开：

```
http://192.168.31.120:5173/
```

- `192.168.31.120` 是本机 WLAN 在当前路由器下分配的 LAN IP（示例环境）。IP 可能随 DHCP 租约变化，请以本机 `ipconfig` 中「无线局域网适配器 WLAN」的 IPv4 地址为准。
- 若终端显示端口被占用而自动改用 `5174` 等端口，URL 中的端口需同步替换。

### 关于 `169.254.10.20`（不可用）

`169.254.10.20` 属于 **`169.254.0.0/16` 链路本地地址（APIPA）**，是操作系统在无法从 DHCP 获取地址时自动分配的**自治地址**。该地址只在直连链路本地有效，**不经过路由器转发，其他 PC 无法跨网段访问**，请勿把它当作访问地址写入分享链接或文档。

## 3. 快速开始

```bash
# 方式一：配置已生效，直接启动即可（推荐）
npm run dev

# 方式二：显式声明监听全部网卡（等价于方式一，便于排错时明确意图）
npm run dev:lan

# 生产构建预览（默认 4173 端口）
npm run build
npm run preview:lan
```

启动后终端应出现类似：

```
  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.31.120:5173/
```

若看不到 `Network` 行，说明未监听外部网卡，请检查 `vite.config.ts` 的 `server.host` 是否被改回 `localhost`。

## 4. Windows 防火墙放行入站端口

即使 Vite 已监听 `0.0.0.0`，Windows 防火墙默认仍会拦截外部入站连接。需为 TCP 5173 添加入站规则。

### 4.1 命令行（推荐，以管理员身份运行 PowerShell）

```powershell
New-NetFirewallRule `
  -DisplayName "Vite Dev Server (TCP 5173)" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 5173 `
  -Profile Private `
  -Action Allow
```

如需放行预览端口 4173：

```powershell
New-NetFirewallRule `
  -DisplayName "Vite Preview (TCP 4173)" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 4173 `
  -Profile Private `
  -Action Allow
```

> `-Profile Private` 表示**仅专用网络**生效，不要在公用网络（咖啡馆、机场等）下放开此端口。

删除规则（不再需要时）：

```powershell
Remove-NetFirewallRule -DisplayName "Vite Dev Server (TCP 5173)"
```

### 4.2 图形界面

1. `Win + R` 输入 `wf.msc` 打开「高级安全 Windows Defender 防火墙」；
2. 选择「入站规则」→「新建规则」→「端口」→ 下一步；
3. 选择 `TCP`，特定本地端口填 `5173` → 下一步；
4. 选择「允许连接」→ 下一步；
5. 勾选**「专用」**（不要勾选「公用」）→ 下一步；
6. 名称填 `Vite Dev Server (TCP 5173)` → 完成。

## 5. 网络前提条件

1. **同一路由器 / 同一网段**：两台 PC 必须连在同一个路由器下，且处于同一 IP 网段（如均为 `192.168.31.x`）。
2. **关闭 AP 隔离（客户端隔离）**：部分路由器默认开启 AP 隔离，会阻止无线客户端之间互相通信。若已 ping 通网关但打不开页面，请登录路由器管理页关闭「AP 隔离 / 无线隔离 / Client Isolation」。
3. **关闭或调整代理**：若访问 PC 开启了全局代理/VPN，本地网段请求可能被代理劫持。请在代理设置中把 `192.168.31.*` 加入绕过列表，或临时关闭代理后重试。
4. **本机网络配置设为「专用网络」**：`设置 → 网络和 Internet → WLAN → 当前网络 → 网络配置文件类型` 选「专用网络」，否则上述防火墙规则不会生效。

## 6. 排错清单

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| `无法访问此网站` / 连接被拒绝 | Vite 仍绑定 `127.0.0.1` | 检查 `server.host` 与启动命令，确认终端有 `Network:` 行 |
| 能 ping 通 IP，但浏览器打不开端口 | Windows 防火墙拦截 | 按 §4 添加入站 TCP 5173 规则（仅专用网络） |
| ping 不通 IP | 不在同一网段 / AP 隔离 / IP 写错 | 核对两台 PC 的 `ipconfig`，关闭 AP 隔离 |
| 页面能开但热更新报连接错误 | HMR 端口推断错误 | 确认 `server.hmr.clientPort = 5173`，并确认端口未被自动顺延 |
| 用 `169.254.x.x` 访问失败 | 链路本地地址不可跨 PC | 改用 WLAN 的 `192.168.x.x` 地址（见 §2） |
| 端口不是 5173 | `strictPort: false` 自动顺延 | 以终端打印的实际端口拼 URL |

本机自检（在服务器上执行，应返回 HTTP 200）：

```bash
curl -I http://127.0.0.1:5173/
curl -I http://192.168.31.120:5173/
```

## 7. 安全提示

- `host: '0.0.0.0'` 会把开发服务器**暴露给整个网段**，同网段的任何设备都能访问，且 dev server 不具备生产环境的安全加固。
- **仅限可信 LAN（家庭 / 公司内网）使用**。切勿在咖啡馆、酒店、校园网等公用网络下启动，也不要把该地址映射到公网。
- 调试完毕后建议停止服务（`Ctrl + C`），或删除 §4 中添加的防火墙入站规则。
- 若需对外提供访问，请先构建并用具备鉴权与 HTTPS 的正式服务器托管，而不是暴露 Vite dev server。

## 8. FPS 压测脚本（E2 关联）

E2 的 FPS 压测基准通过 npm 脚本调用，**不需要直接调用 node 命令**：

```bash
npm run bench:fps
# 带参数示例（由 E2 脚本定义的具体参数为准）
npm run bench:fps -- --platform=both --runs=3 --out=docs/perf/fps-report.json
```

该脚本由 `package.json` 中的 `bench:fps` 映射到 `node scripts/fps-bench.mjs`，依赖 `@playwright/test@1.65.1`（已在 devDependencies 中声明，集成阶段统一安装）。压测默认访问本机 `http://127.0.0.1:5173/`，无需局域网配置；若要压测 LAN 地址，可在脚本支持的情况下通过 `--base-url=http://192.168.31.120:5173/` 指定。
