# Zeonest

Zeonest 取自 Zeolite（沸石）+ Nest（巢），意为「沸石之巢」：借沸石的多孔结构，形容一个壳容纳多种功能。

这是个人维护的 Paseo 扩展合集，插件 ID 为 `zeonest`。子功能统一分发、按需开启，壳管理功能目录、开关和配置入口。

## 子功能

<!-- zeonest:features:start -->

当前包含 **7** 个子功能，默认均关闭；点击名称查看使用说明。

| 名称 / ID | 描述 | 版本 | 标签 | 作者 |
| --- | --- | --- | --- | --- |
| [问答选项回顾](features/ask-user-question/README.md)<br><code>ask-user-question</code> | 在已完成的 ask&#95;user&#95;question 折叠块中保留全部选项、说明和用户答案。 | 0.1.2 | <code>界面</code> <code>Pi</code> | hyrilx |
| [Billion Context](features/billion-context/README.md)<br><code>billion-context</code> | 托管 Bili 服务，让 Pi 与 dashboard 使用同一固定实例 | 0.4.0 | <code>context</code> <code>dashboard</code> | hyrilx |
| [历史对话展开](features/chat-history/README.md)<br><code>chat-history</code> | 将消息中的 Chat history 摘要展开为可折叠的历史对话 | 0.1.2 | <code>chat</code> <code>history</code> | hyrilx |
| [文件活动](features/file-activity/README.md)<br><code>file-activity</code> | 按轮查看当前会话的文件增删改查记录与差异 | 0.1.2 | <code>files</code> <code>conversation</code> | hyrilx |
| [Pi 设置](features/pi-settings/README.md)<br><code>pi-settings</code> | 管理全局与项目的 Pi 模型、技能、插件和 MCP，应用前审阅配置 diff | 0.1.1 | <code>pi</code> <code>configuration</code> | hyrilx |
| [Pi 状态桥接](features/pi-status-bridge/README.md)<br><code>pi-status-bridge</code> | 按会话汇总 Pi 插件状态，查看全文并调用映射的展开命令 | 0.2.0 | <code>pi</code> <code>status</code> | hyrilx |
| [会话统计](features/session-stats/README.md)<br><code>session-stats</code> | 通过聊天胶囊查看会话轮次、工具用时与估算输出速度。 | 0.2.0 | <code>效率</code> <code>统计</code> | hyrilx |

<!-- zeonest:features:end -->

## 安装与使用

需要 Paseo 客户端与 daemon 0.15.4+。

插件服务端以 daemon 用户权限运行，可访问文件、进程、凭据和网络。在目标宿主的 **Settings → Plugins** 安装本目录，或运行：

```bash
paseo plugin install /absolute/path/to/paseo-zeonest
paseo plugin ls zeonest
```

源码目录和 Git 安装会安装锁定依赖并构建，详见[安装与打包流程](docs/development.md#源码安装与预构建包)。

### 管理功能

点击 Zeonest 配置按钮，或在 Command Center 搜索「Zeonest：管理功能集」。保存开关后，在配置页的「插件操作」中点击「重新加载插件」使变更生效。该操作由服务端调用 Paseo CLI，要求 daemon 的 PATH 中可执行 `paseo`；执行前会核对目标 daemon 的进程 ID，避免重载其他宿主。

自重载可能关闭配置页或中断当前请求；若页面提示结果尚未确认，请查看 Paseo 插件状态和日志，再重新打开配置页。也可继续使用宿主插件菜单的「重新加载」，或运行：

```bash
paseo plugin reload zeonest
paseo plugin logs zeonest
```

插件菜单只提供一个「功能集」配置入口。在子功能卡片中点击「打开配置」，通过「返回功能集」回到列表；功能关闭后仍可配置。各宿主设置独立，同一宿主的客户端共享设置。

修改源码后先运行 `npm run build`，再重载插件。

## 开发

需要 Node.js 22+ 和 npm，Paseo SDK 固定为 `@getpaseo/plugin@0.15.4`。

```bash
npm ci --ignore-scripts
npm run hooks:install
npm run check
npm pack --dry-run --ignore-scripts
```

`hooks:install` 启用本仓库的 pre-commit hook，提交时按暂存区的功能元数据更新并暂存 README 功能目录。详见[提交 hook 说明](docs/development.md#readme-功能目录与提交-hook)。

### 新增子功能

```bash
npm run feature:new -- prompt-tools \
  --name "提示词工具" \
  --description "管理个人常用提示词" \
  --author "你的名字" \
  --runtime both --settings --tag productivity
```

在仓库根目录的 `.author` 中写一行作者名，即可省略 `--author`。脚手架优先使用 `.author` 去掉首尾空白后的内容；文件不存在或为空时才使用 `--author`。`.author` 不提交到 Git。

脚手架在 `features/prompt-tools/` 创建贡献入口、README 和可选配置页，功能元数据在 `feature.json` 中维护。单端功能用 `--runtime client` 或 `--runtime server`，无配置页则省略 `--settings`。实现业务与测试后运行 `npm run check`。

子功能使用 Paseo 原生 context 和 cleanup，代码与测试集中在 `features/<id>/`。构建自动扫描并完成静态组合，接入规则见[子功能规范](docs/features.md)。

### 常用命令

```bash
npm run docs:features            # 更新 README 功能目录，随功能提交
npm run docs:features -- --check  # 仅检查目录是否同步
npm run build                    # 完整校验、双端构建、产物检查及目录更新
npm run typecheck                # 源码、内存静态接线及测试类型检查
npm test                         # 递归运行根 tests 与各功能 tests
npm run bundle:check             # 检查已构建产物的原生入口图和 external
```

## 源码导航

| 路径 | 用途 |
| --- | --- |
| `features/<id>/` | 单个功能的源码、元信息、README、测试与 fixtures |
| `shell/{client,server,shared}/` | 壳的实现与内部 helper |
| `index.client.tsx`、`index.server.ts` | 双端原生入口 |
| `client/bundle.js`、`server/bundle.js` | 构建生成的双端 bundle |
| `tools/` | 扫描、脚手架、构建与验证工具 |
| `tests/` | 壳、工具与集成测试 |
| `.agents/skills/` | 壳与子功能的维护指南 |

进一步阅读：[架构](docs/architecture.md)、[子功能接入](docs/features.md)、[开发与验证](docs/development.md)、[代理开发约定](AGENTS.md)。
