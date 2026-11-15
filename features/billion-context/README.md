# Billion Context

在侧边栏提供 billion-context dashboard 总览入口，在聊天框底部提供「上下文详情」胶囊。新增功能默认关闭，启停通过整体重载 Zeonest 生效。

## 使用

1. 先运行 billion-context 的 Web UI，在 Zeonest 的 Billion Context 配置页填写源地址，默认 `http://127.0.0.1:8787`。
2. 启用功能并整体重载插件。配置保存后，下次打开入口即使用新地址；功能关闭时仍可编辑配置。
3. 点击侧边栏「Billion Context」，选择此宿主的工作区并打开总览。
4. 点击聊天框底部「上下文详情」。服务端读取当前 agent 的 `persistence.sessionId`，查询精确映射后打开对应会话。

桌面端通过 Paseo 原生 `navigation.openBrowser` 在工作区浏览器打开页面。Web、iOS、Android 通过页面上的明确链接打开外部浏览器。桌面跳转失败时显示错误，由用户选择重试或打开外部浏览器，不自动切换。

Paseo SDK 固定为 0.15.4，没有原有上下文圆环的点击扩展点，因此使用独立胶囊。SDK 的文档预览组件禁止脚本，不能承载 dashboard。

## 地址配置

- **宿主侧实例地址**：daemon 用于查询会话映射的 HTTP(S) 源地址。只能填写源地址，不能包含路径、查询参数、账号或密钥。
- **客户端访问地址**：可选，留空时沿用宿主侧地址。两个地址必须指向同一个 billion-context 实例。远程连接时可填写经过安全隧道转发的客户端地址。

总览路径为 `/__bili/`；会话路径为 `/__bili/#/session/<encoded-session-id>`。不要将完整 Web UI 路径填入源地址。

billion-context 0.1.215 的 Pi inline 模式默认开启，Web UI 使用随机回环端口。请从 billion-context 日志或 Web UI 链接中取得实际源地址。不同 inline 进程可能有不同端口；本功能只查询配置的实例，不自动发现、扫描或切换实例。需要统一入口时，应由用户配置一个能读取目标会话的长期运行实例。实例未收录目标会话时明确报错。

浏览器运行在客户端设备，`127.0.0.1` 指客户端本机；daemon 的回环地址则指宿主。远程宿主和移动端必须使用客户端可达的地址或安全隧道。Dashboard 可能包含完整对话内容，应保留回环监听或使用受保护的连接，避免直接公开监听端口。

## 会话定位与失败处理

只读查询 `GET /__bili/plugin/status?conversationId=<provider-session-id>`，使用返回的真实 `sessionId`，不会把 Paseo agent ID 当作 billion-context session ID。不会使用 `fallback=latest`，不按标题、目录或最近活动猜测。

尚无 provider session ID、首轮请求尚未建立压缩会话、实例未收录会话、会话已切换或归档、网络错误、无效响应都会在入口页显示错误。详情查询前后检查会话身份；关闭插件会中止进行中的 HTTP 请求。请求时限 5 秒，响应上限 256 KiB，不跟随重定向。

胶囊每 3 秒从宿主读取未归档的 agent 列表，原地保留未变化的注册；删除、归档、工作区改变或读取失败时移除旧注册。点击才查询 dashboard，不在后台轮询 dashboard。所有会话都提供入口，未接入 billion-context 的会话会明确提示未找到。

## 数据与资源

- 使用 Paseo 原生 RPC、设置、侧边栏、屏幕和 composer pill，不依赖其他子功能或壳 helper。
- 通过 Paseo 读取工作区元信息、agent 元信息和 provider session ID；后者仅发送给配置的 billion-context 实例。
- 不读取会话文件、数据库或凭据，不写入聊天历史，不修改 provider 环境变量、daemon 配置或会话。
- 不安装、启动或启用 billion-context，不创建隧道，不改变 dashboard 内容和主题。
- 清理时移除客户端贡献和定时器，忽略已关闭页面的异步结果，中止服务端请求。

## 验证

已通过 `npm run check`（类型、源级边界、双端构建、产物边界及 198 项测试）和 `npm pack --dry-run --ignore-scripts`。其中新增 22 项功能测试，覆盖 URL 与配置校验、精确会话映射、分页、网络限制、胶囊清理、入口导航和配置草稿冲突。原有 Pi CLI 集成测试因未设置 `ZEONEST_PI_CLI` 跳过 1 项。

已对 14 个新增 TypeScript 文件发起主动 LSP 检查，但当前无就绪的语言服务器，未取得诊断结果；类型检查以上述 `npm run check` 为准。

真实 Paseo 验收需检查宽屏与 compact、明暗主题、桌面工作区浏览器、Web/移动端外部链接、远程地址，以及未接入会话/离线/归档状态。本次开发未安装或启用插件，真实宿主验收尚未执行。路由依据本机 billion-context 0.1.215 代码核对，其他版本尚未验证。
