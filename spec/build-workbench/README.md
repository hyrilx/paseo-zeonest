# 工作台：构建

方案已确认。功能 ID 为 `build-workbench`，作为 Zeonest 的静态子功能随插件交付，默认关闭。先在 `paseo-zeonest` 跑通 npm 构建，再扩展首版的其余适配器。

## 入口与布局

从 Paseo workspace 的 tab 栏「＋」打开「工作台：构建」。面板使用当前 pane 所属的宿主和 workspace；用户切换 workspace 时，目标、工具链选择和历史一起切换。找不到「＋」入口时先报告宿主版本和复现条件，不擅自换入口或升级 SDK。

```text
工作台：构建                         [工具链：Node / npm ▾]
[子项目：根目录 ▾] [目标：build ▾] [配置 ▾] [运行]
工作目录：当前 workspace               npm run build

运行记录                  #17 build · 运行中   [停止]
  #17 build  运行中        [输出] [产物]
  #16 check  已停止        …
  #15 build  成功
```

目标按相对路径和所属构建系统分组，可以搜索。首版必须能单选子包、crate、模块或独立子项目，同名目标以项目路径区分。单次运行只选一个目标；像仓库根 `build` 这类聚合命令，由项目自己的工具负责执行。窄屏用任务列表与详情切换，保留可达的运行和停止操作。

运行配置保存目标、参数、工作目录及适用的构建选项，运行前显示实际命令。配置可以命名后复用，也可以只运行一次。目标删除时提示重新选，不回退到根目录或同名目标。打开面板、切换配置和刷新静态目标都不执行命令。CMake 配置、Gradle 任务枚举等需要执行项目代码的步骤，单独标明并由用户触发。

无目标时说明扫描了什么及支持的清单；缺工具时列出依赖和版本要求。列表区分排队、运行、成功、失败、已停止；发生断线或无法确认进程退出时显示未知或中断，不标成成功或已停止。

## 工作区工具链

工具链入口就在面板右上角。选择按宿主和 workspace 保存，切换后影响新提交的任务；排队中和运行中的任务保留提交时的选择。运行记录显示所选路径和版本（未验证则明示）。

- 在构建 workspace 的 daemon 端读取宿主 `PATH` 及相关工具定位变量，例如 `JAVA_HOME`、`ANDROID_HOME`、`DEVELOPER_DIR`，不使用打开 Paseo 的浏览器、本机客户端或交互 shell 的环境代替。展示工具路径、来源、已确认版本及与项目要求的匹配状态；不把完整环境或凭据写进日志、配置或 RPC 返回值。
- 对照 `engines`、`packageManager`、`mise.toml` 等声明给出推荐。打开面板时只找候选和读清单，不启动登录 shell、运行 shim 或求值项目配置。涉及 shim、Wrapper 或项目配置的验证须显式触发；区分「找到可执行文件」和「确认可用」。
- 选择仅作用于此功能启动的进程，不改全局 `PATH`、系统默认工具链或项目文件。首版只管理已有工具，不自动安装。管理器可能自带下载行为，例如 `mise exec` 默认可能补装缺失工具；禁用自动安装并按实际支持版本验证。如果不能保证探测阶段不安装，保持“未验证”并说明原因。用户发起的项目脚本仍可按项目定义执行，工作台不承诺隔离网络或文件写入。
- 已固定的工具缺失或版本不匹配时阻止运行、给出原因。如果仓库、命令或工具链在重试前已变更，显示差异并由用户确认；不悄悄换成 `PATH` 上的另一个版本。

## 执行、日志与产物

- 从服务端解析真实 workspace 目录，不接受客户端传入任意目录或自由格式 shell 命令。按已发现的目标及校验过的参数组装可执行文件和 argv，显式操作后才执行。项目脚本本身仍是项目代码，预览要能看见实际目标；存在 `pre`/`post` 等工具原生行为时遵循该工具。
- 每次运行都有独立 ID、状态、配置快照和输出。并发有上限；同目标或会写同一目录的任务串行，写入范围未知的任务默认与该工作区的其它任务串行。不同 workspace 如果实际共用输出路径，也不能并发写同一份产物。
- 输出按运行 ID 和游标分段读取，显示 stdout/stderr，不接收交互输入。关闭 tab 不停止任务；重开后接着读。保存有界日志并标明截断。所有查询、停止与重试都校验宿主、workspace 和运行归属。
- 停止只作用于选中的任务，处理子进程并在确认退出后结束状态；如果只是排队，移出队列即可。失败或停止后可用原配置重试，生成新的运行 ID，旧日志留在原记录，其他任务不受影响。插件停止时释放运行资源、拒绝新的业务 RPC；不声称支持 daemon 重启后恢复进程。
- 产物查看限定在用户配置或适配器明确知道的工作区输出路径内。防止路径或符号链接越界；区分本次观测到的新增、变化、已有输出和缺失目录，不将已有文件归为本次构建产物。失败和停止仍保留日志和已观察结果。首阶段用 `client/` 和 `server/` 验证产物视图。

## 首版适配范围

以下目录均在 `/Users/hyrilx/02-dev/`。它们是验收样本，运行时代码不写死这些绝对路径。

| 阶段 | 项目 | 首版验收目标与前置条件 |
| --- | --- | --- |
| A | `paseo-zeonest` | npm 适配器从根 `package.json` 发现目标，使用 Node `>=22` 和 npm 跑通 `npm run build`，查看 `client/`、`server/`。`build` 与 `check` 等会共享输出的任务不并发。 |
| B | `homent-system` | 单选 Cargo 子包 `homent-agent-server` 与 pnpm 包 `@homent/web-ui`，分别构建。兼容项目通过 mise 启动工具的方式；不运行真实设备或推送任务。 |
| B | `lone-singer-music` | 分别选 `apps/web` 和 `apps/server` 的 `build`，区分日志与产物。使用 mise 固定的 Node `24.14.0` / pnpm `11.20.0`；根聚合构建归项目管理。 |
| B | `vofa_bridge` | 经用户触发配置后，发现并构建 CMake 的 `example`、`player`，不启动示例。需要 C++20 编译器和 `fmt`；本地清单未声明 `project()` 或 preset，先确认独立配置是否可用、是否需从父工程进入。 |
| B | `eligos` | 从非 Git 根目录的本地 workspace 选择独立项目：Rust（如 `eligos-core`、`fake-client`）与 Tauri（如 `eligos-livestream`）。验收 Cargo 和 Tauri Debug 构建；需要 `protoc`、Node/pnpm 及宿主平台 SDK。Windows C# 和 Keil 不纳入。 |
| B | `alkaa` | Android `:app:assembleDebug`，桌面 `:desktop-app:createDistributable`，iOS `alkaa` 模拟器构建。使用仓库 Gradle Wrapper、JDK 17、Android SDK 36；iOS 需 macOS 和完整 Xcode。发布签名不纳入。 |

当前只实现 A。B 是已确认的首版后续范围，不要求一次实现多个构建系统，也不先搭通用编排框架。首版不做 watch、PTY、调试器、CI、依赖调度图或工具安装器。

## 阶段 A 验收

1. 用静态 fixture 验证根脚本发现、无清单、非法/变更的清单和缺工具状态。单独验证被动发现不启动命令，运行时不会退到错误的工作目录或版本。阶段 B 扩充包路径与同名任务用例。
2. 在任务 worktree 对应的 `paseo-zeonest` 验收根 `build`、实时输出、结果和声明的产物目录。在隔离 fixture 证明两项不冲突的任务可以并行、共享输出的任务排队、停止只影响选中任务、失败/停止后的重试保留旧日志。用两个 workspace 验证设置与运行数据不会串用。
3. 运行 `npm run check`、`npm pack --dry-run --ignore-scripts` 和改动文件的主动 LSP 检查。真实 Paseo 宽屏及 compact、明暗主题要检查「＋」入口、操作和空/错误状态；无法访问或缺少安装/启用/重载授权时，写明宿主验证待办，不用自动化结果充当真机验收。

## 接入与证据

接入遵循 [仓库开发约定](../../AGENTS.md)、[架构](../../docs/architecture.md) 和 [子功能规范](../../docs/features.md)。直接使用 `@getpaseo/plugin@0.15.4` 原生贡献；实现和行为测试都放入 `features/build-workbench/`，不改壳的职责。服务端业务 RPC 同步声明在 `server/rpc.ts(x)`，关闭、启动失败或 cleanup 后拒绝业务。使用一元 RPC 加游标读取输出，不引入新版本的订阅 API。POSIX 上 SDK 进程 helper 的 `kill` 只向直接子进程发送信号；停止语义需要按实际平台管理、测试进程组或进程树。

- Paseo v0.15.4 的[桌面 tab 栏「＋」](https://github.com/getpaseo/paseo/blob/v0.15.4/packages/app/src/screens/workspace/workspace-desktop-tabs-row.tsx#L232-L260)打开 [新 tab 菜单](https://github.com/getpaseo/paseo/blob/v0.15.4/packages/app/src/screens/workspace/workspace-new-tab-menu.tsx#L51-L103)，其[目录](https://github.com/getpaseo/paseo/blob/v0.15.4/packages/app/src/workspace-tabs/launcher/index.tsx#L200-L251)包含同宿主且适用于当前 pane 的插件 workspace panel。[面板渲染器](https://github.com/getpaseo/paseo/blob/v0.15.4/packages/app/src/plugins/workspace-panels/panel.tsx#L36-L97)提供当前宿主和 workspace。该链路有版本源码证据，尚未做本功能的真机验证。
- [Paseo v0.15.4 工作区文档](https://github.com/getpaseo/paseo/blob/v0.15.4/public-docs/workspaces.md)说明可把普通目录作为本地工作区。用于 `eligos/`，不依赖 Git worktree。
- 交互参考 JetBrains 的 [Run configurations](https://www.jetbrains.com/help/idea/run-debug-configuration.html)、[npm 运行配置](https://www.jetbrains.com/help/idea/run-debug-configuration-npm.html)及 [Build 工具窗口](https://www.jetbrains.com/help/idea/build-sync-tool-window.html)：命名配置、临时运行、任务输出、停止和重跑。界面使用 Paseo 原生组件和主题，不照搬 JetBrains 布局。
