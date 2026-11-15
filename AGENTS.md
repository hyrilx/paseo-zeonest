# Zeonest 开发约定

这是静态聚合的 Paseo 插件，ID 为 `zeonest`，不是插件市场、动态加载器或通用业务框架。

## 开始之前

1. 先读 [README](README.md) 和 [架构](docs/architecture.md)。
2. 新增或修改子功能时读 [子功能规范](docs/features.md) 和 `.agents/skills/zeonest-feature/SKILL.md`。
3. 修改壳时读 `.agents/skills/zeonest-shell/SKILL.md`。
4. Paseo API 以本仓库锁定的 `@getpaseo/plugin@0.15.4` 类型和对应宿主版本为准。在线文档可能比已发布 SDK 更新；使用新 API 必须同步更新依赖、manifest 最低版本和验证记录。

## 边界

- 壳只负责展示元信息、保存开关、组合原生贡献与路由配置入口。
- 不增加子功能基类、容器上下文、统一业务配置 schema、事件总线、权限抽象或生命周期 SDK。
- 子功能直接接收原生 `PluginClientContext` / `PluginServerContext`，返回 Paseo 原生 cleanup。
- 服务端业务 RPC 在可选 `server/rpc.ts(x)` 中同步声明，功能内部拒绝未启用或已停止时的业务调用；业务 hooks/监听仍在 `server/index.ts(x)`。0.15.4 的 RPC 名称目录不接受异步开关读取后的迟到注册。
- 启停通过整个插件重载生效。不实现热注入、依赖解析、远程发现或独立子功能分发。
- 手写功能全部放在 `features/<id>/`（六项 feature.json、README、client/server/shared、tests/fixtures），壳放在 `shell/client`、`shell/server`、`shell/shared`。无需求的可选目录不强制创建。
- 每个源码归属内保持本端/shared 边界，包含 type-only 和传递依赖；shared 不引入 Node、React 或端专用 SDK/类型。功能不得依赖其他功能或壳内部 helper，运行代码不得依赖测试/fixtures 或仓库根 `tools/`；运行端内部的业务 `tools/` 子目录不受此目录名限制。
- 根目录只保留两个固定原生入口，各自只重导出本端 bundle。根 `client/`、`server/` 是构建独占的可删除输出，不放手写代码，不提交产物。宿主库保持 external，不能通过 alias/软链接/伪装依赖绕过 0.15.4 的运行目录检查。
- 配置 UI 使用 React Native 和 Paseo 原生 Settings 组件，颜色取自主题，适配 compact。
- 子功能配置属于子功能。壳不得读取、解释、合并或重置它；功能关闭时配置入口仍然可用。
- 子功能内部结构和实现方法自主。接入文件是静态组合约定，不是新的运行时接口。

## 修改与验证

- 统一 `npm run build` 自动扫描和校验功能，使用内存中的静态 imports/元信息/原生贡献表直接输出双端 bundle。不得再创建需同步提交的接线清单。
- 正常新增功能仅改 `features/<id>/`；新增第三方依赖等合理例外才改根配置。脚手架不得改壳或根入口，测试递归发现功能 tests，根 tests 仅承载壳/工具/整体集成。
- 源码/Git 安装依赖 manifest 的显式准备命令，不只依赖 npm 生命周期脚本；预构建包的准备入口必须只使用随包携带的文件，不安装开发依赖或调用缺失工具。
- 不提交演示功能、真实凭据或个人运行数据。新增子功能默认关闭。
- 运行 `npm run check`（全类型/测试/源级边界/双端构建/产物边界）和 `npm pack --dry-run --ignore-scripts`；主动检查改变源码的 LSP，若不可用须报告，不能把空缓存当通过。
- UI 还需在真实 Paseo 检查宽屏、compact、明暗主题及出错状态；未执行就明确说明。
- 未获用户授权，不安装/启用插件，不修改 daemon 的 `pluginsEnabled`。不要重启 daemon 来加载源码。
