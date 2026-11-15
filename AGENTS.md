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
- 启停通过整个插件重载生效。不实现热注入、依赖解析、远程发现或独立子功能分发。
- 代码必须遵循 Paseo 的 `client/`、`server/`、`shared/` 边界，根目录只放两个运行时入口。共享代码不引入端专用 API。
- 配置 UI 使用 React Native 和 Paseo 原生 Settings 组件，颜色取自主题，适配 compact。
- 子功能配置属于子功能。壳不得读取、解释、合并或重置它；功能关闭时配置入口仍然可用。
- 子功能内部结构和实现方法自主。接入文件是静态组合约定，不是新的运行时接口。

## 修改与验证

- 不手改 `*.generated.ts`；修改输入后运行 `npm run features:sync` 并提交生成结果。
- 不提交演示功能、真实凭据或个人运行数据。新增子功能默认关闭。
- 运行 `npm run check` 和 `npm pack --dry-run --ignore-scripts`。
- UI 还需在真实 Paseo 检查宽屏、compact、明暗主题及出错状态；未执行就明确说明。
- 未获用户授权，不安装/启用插件，不修改 daemon 的 `pluginsEnabled`。不要重启 daemon 来加载源码。
