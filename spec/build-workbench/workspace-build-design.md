# 工作台：构建设计

在 Paseo 的 workspace 内发现构建目标、选择工具链并运行任务。每次运行都可以单独查看输出和产物、停止或重试。`build-workbench` 作为 Zeonest 的静态子功能交付，默认关闭。

首版覆盖 npm/pnpm scripts、Cargo、CMake、Tauri、Gradle 和 Xcode，验收范围见下表。任务可以是项目已有的构建、编译、检查或其他有限时长的命令。首版不做 watch、PTY、调试、CI、依赖调度图或宿主工具安装器，也不提供自由输入的 shell 执行器。

## 入口与操作流程

从 Paseo workspace 的 tab 栏「＋」打开「工作台：构建」。面板跟随当前 pane 的宿主和 workspace；切换 workspace 时，目标、工具链、配置和运行记录一起切换，单纯切换视图不会停止原任务。找不到「＋」入口时先报告宿主版本和复现条件，不擅自换入口或升级 SDK。

```text
工作台：构建                         [工具链：Node / pnpm ▾]
[子项目：apps/web ▾] [目标：build ▾] [配置：预发布 ▾] [运行]
工作目录：apps/web                  pnpm run build --mode staging

运行记录                  #17 apps/web › build · 运行中  [停止]
  #17 web     运行中       [输出] [产物]
  #16 server  已停止       …
  #15 web     成功
```

- **选择目标**：按相对路径和构建系统分组，支持搜索。单次选择一个子包、crate、模块或独立子项目及其目标。同名目标带项目路径，如 `apps/web › build` 和 `apps/server › build`。仓库已有的聚合命令作为独立目标展示，由项目工具编排。
- **设置并运行**：临时配置可直接运行；常用配置可命名保存。配置包含目标、工作目录、工具支持的参数或构建选项（例如 Cargo profile、Gradle 模块任务、Xcode scheme 和 SDK）。启动前预览实际命令、工作目录和所选工具链；工作台安排的依赖准备步骤单独列出。参数按适配器的语义校验并传递为 argv，不拼接为 shell 文本。原目标被删除或移动时提示重新选，不回退到同名或根目录目标。
- **查看和处理任务**：宽屏把运行列表和所选详情并排，compact 用列表与详情切换，仍能直接找到运行、停止和重试。详情显示状态、命令、退出结果、只读输出和产物。重试从具体运行记录发起，不借用当前表单的配置。
- **提示阻塞原因**：没有目标时列出扫描范围、支持的清单和可刷新的入口；清单有误时标出文件和原因；缺工具时贴出要求、已发现候选和检查入口。RPC 断线显示连接异常，不改写服务端最后确认的任务状态。

## 项目与目标发现

服务端根据当前宿主的 workspace ID 解析实际目录，支持 Git worktree 和普通目录。先读取有界范围内的已知清单和显式项目声明，跳过依赖目录、生成目录以及指向工作区外的符号链接。目标用「适配器 + 项目相对路径 + 工具原生目标」区分；同一项目可以提供多种构建系统的目标。每个候选标明来源，说明可直接运行，还是需要另一步配置或探测。

打开面板、切换配置、刷新静态目标只读文件，不启动项目进程。Cargo workspace 声明、npm/pnpm 包清单、CMake preset、Gradle 设置和 Xcode 工程可以给出候选。静态读取不能保证得出完整目标集：CMake configure、Gradle 任务枚举、Xcode scheme 枚举等命令要单独展示并经用户触发，返回工具确认的目标。刷新不会自动运行项目脚本、启动设备或补装工具。

适配以技术栈的清单、工作区声明和工具查询为准。Gradle 从 Groovy/Kotlin 构建入口调用原生任务枚举，模块名和任务由 Gradle 提供；Xcode 从工程或工作区查询 scheme；CMake 从配置及 File API 读取目标。Cargo 的构建脚本和 Tauri 的前端构建钩子交给各自工具执行。产物线索来自清单、工具返回值或标准输出目录；非标准路径由使用者补充。验收样本中的包名、模块名、插件、JDK/SDK 版本、依赖名和输出路径不作为通用判定条件。

Gradle 的任务枚举逐行读取 stdout，与面板的滚动日志分开。只有成功退出且解析出任务列表的探测才会发布结果；失败、取消或无可识别列表时保留同一项目指纹下仍有效的结果。单次最多记录 256 项：优先保留带模块路径的 variant 装配、打包和分发入口，其次保留其他模块和根项目的构建入口，再保留模块和根项目的辅助任务。中间资源、类文件和元数据任务不占用 variant 入口的优先级；同优先级保留先出现的条目。单行超过 16 Ki 字符时跳过该行；如果影响任务列表，和达到条目上限一样标记为部分结果。工作区最多显示 512 项，超限时优先保留探测入口及原生构建目标，并在面板提示。Xcode 的 JSON 枚举仍使用独立的有界缓冲。

发现与执行都遵守工作区边界。客户端提交的是已识别的目标及校验过的选项，不传任意可执行文件和目录。服务端在运行前重查目录和目标；路径越界、目标失效或选项不受支持时不启动。构建脚本仍以 daemon 用户的权限运行，信任 workspace 的项目代码是执行前提。防路径越界约束的是工作台自身的发现、执行入口和产物浏览，不等同于沙盒。

## 工作区工具链

工具链入口在面板右上角。工具候选、选中项和运行配置属于当前宿主和 workspace。可以对同一工作区内的不同构建系统分别选择工具，例如 Cargo 用 Rust 工具链，Web 包用 Node/pnpm。选中的工具及必要搭配随运行提交：排队中和运行中的任务不因 UI 改选而换工具。

| 操作 | 行为 |
| --- | --- |
| 发现 | 在 workspace 所在 daemon 读 `PATH`、`JAVA_HOME`、`ANDROID_HOME`、`DEVELOPER_DIR` 等工具定位变量，以及用户已有的 mise 安装目录。按可执行文件发现工具，包名和命令可以不同（如 `protobuf` 提供 `protoc`），也支持 macOS 的 CMake 应用包。对照 `engines`、`packageManager`、`mise.toml`、Wrapper 或工具链声明；展示实际候选路径，不以浏览器或交互 shell 的环境代替。 |
| 检查 | 明确区分「找到候选」「版本已验证」「缺失或不匹配」「未验证」。检查直接运行已安装工具的版本命令，不运行项目脚本或 Wrapper。对 Gradle 显示确认的启动 Java，并注明 Gradle 项目本身可以选择另一套构建 JVM。首次执行原生探测时才运行 Wrapper 或加载项目配置。 |
| 选择 | 保存工作区选择，只作用于本功能启动的进程，不改全局 `PATH`、项目文件或系统默认 SDK。展示实际路径与已确认版本；不把完整环境和凭据写进配置、日志或 RPC 返回值。 |
| 使用 | 发现固定路径已失效或版本不匹配时阻止运行并提示，不默默降级到 `PATH` 上的另一个版本。工具检查优先使用 mise 的实际安装路径而非 shim。用户主动执行的项目探测和构建允许按项目声明下载依赖或准备构建环境。 |

版本判断以实际执行链为准。mise 声明从所选项目目录向工作区根查找，支持中间目录的配置；同一宿主可列出多个 Xcode 安装和多组 Tauri Rust/JS 工具链。Gradle 自行解释 Java toolchain、Android SDK、仓库设置和 Kotlin 编译策略，CMake 自行处理 preset、生成器、编译器和依赖检查。发现 Ninja 或 protoc 不代表选中的构建需要它们，工具版本检查不以它们是否可运行作为门槛。

## 构建选项

构建意图由已发现的原生目标表达。Gradle 从任务列表选择模块及 variant，例如 `:mobile:assembleDemoRelease`，不根据 `:app` 或 Debug 命名推断项目；也接受 `-P`、`-D`、并行度等选项。Xcode 的 scheme 与 configuration 分开选择，保持无签名模拟器构建。Cargo 支持 profile、features 和 target，CMake 区分 configure 的生成器和缓存参数、build 的 configuration 和并行度。Tauri 支持 Debug/Release、配置叠加、features、target 和常见 Cargo 参数，仍使用 `--no-bundle`。npm/pnpm 将选项原样作为参数传给所选脚本。

参数输入支持引号和反斜杠，预览保留参数边界。适配器校验的是该次操作和参数语义，不固定项目属性值或构建变体。决定工作目录、目标和操作的参数由工作台设置；不提供替换可执行文件、修改 CMake 受管构建目录或切换至发布、签名、设备操作的入口。

## 依赖准备

打开、刷新和预览仍然只读。用户点「执行探测」或「运行」后，Gradle Wrapper 可以下载发行版，Gradle、Cargo、CMake 和 Xcode 可按各自的项目配置解析依赖、下载或使用本地缓存。npm/pnpm 目标及由它们提供 CLI 的 Tauri 目标缺少已声明的直接依赖时，工作台在所属包或 workspace 根安排安装步骤，根据锁文件选用对应的安装命令。没有锁文件时，安装可以生成锁文件。工作台不提供宿主范围的工具安装、设备操作或发布入口。

npm/pnpm 准备前检查声明的直接依赖、可比较的版本范围、锁文件与安装记录的时间，以及 pnpm 已生成的 PnP 文件。这些检查是准备依据，不代替包管理器校验整棵依赖树。安装和构建共用一条运行记录、队列和日志；安装失败或被停止，构建不启动。从该条记录重试时，即使残留的文件看起来已安装，也重新执行未完成的准备步骤。已成功的准备步骤不会仅因构建失败而重跑。工具内部的依赖准备随构建日志显示。

## 执行、并发与重试

每次提交建立独立运行记录，包含 ID、工作区、项目目标、参数、工作目录、命令与工具链快照。开始、读取、停止与重试均校验宿主、workspace 和运行归属。状态从排队到运行，再到成功、失败或已停止；停止请求发出但未确认退出期间显示「正在停止」。若无法确认最终状态，显示中断或未知，不能把请求已发送当作已停止。

并发有上限。相同目标或可能写入同一目录的任务排队；不同 workspace 如果共享输出路径也要串行。输出范围未知的任务默认与同 workspace 的其他任务串行，不根据任务叫 `lint` 或 `check` 就假定只读。已确认写入互不冲突的任务可以同时运行，各自保有日志、停止操作和产物视图。资源占用在进程退出或以其他方式确认释放之后解除。

停止排队任务只移出队列。停止运行中任务要管理其子进程，不能只杀 npm 或 Gradle 的外层进程就标记完成；不影响同一宿主上其他任务或无关共享服务。失败或停止后重试会按原配置重新提交、生成新 ID、保留原记录，需要时进入队列。若命令、声明或工具链已变化，先显示差异并让用户确认，既不偷偷切换目标，也不承诺重试能复原之前的源码和依赖。

## 输出与产物

- **输出**：stdout/stderr 按运行 ID 和游标分段读取；新输出持续追加，关闭 tab 不停止任务，重开可继续读。记录有大小和保留上限，截断处明确提示。输出是只读文本，不提供终端输入。记录配置及状态时避免写入敏感环境，项目自行打印的内容仍按构建日志处理。
- **产物**：仅查看适配器知道或用户指定的工作区相对输出路径。解析真实路径，拒绝通过绝对路径、上层目录或符号链接越界。列出构建前后观测到的新增、变化、已有文件和缺失目录；观察结果不等同于文件来源证明。失败或停止仍可查看已捕获的输出和产物变化。产物留在构建工作区，功能不复制、发布或自动清理它们。
- **生命周期**：已保存配置与有界记录由该子功能管理，按 workspace 隔离；壳不读取或重置。插件停止时拒绝新的业务调用并清理自己启动的任务资源。daemon 重启时不恢复之前的进程，不把仍显示在历史中的进程当作可控制的活动任务。

## 适配与项目验收

验收样本位于 `/Users/hyrilx/02-dev/`。表中项目仅用于验收，不参与运行时识别和校验。用结构不同的 fixture 检查适配规则，例如非 `:app` 模块、Groovy Gradle、冷 Wrapper、独立 Xcode 工程、CMake 可选依赖、Tauri 的不同前端钩子和不在 PATH 上的 mise 工具。

| 项目 | 目标发现与构建 | 工具链和产物验证 |
| --- | --- | --- |
| `alkaa` | 使用 Gradle Wrapper 选择 Android `:app:assembleDebug`、桌面 `:desktop-app:createDistributable`；在 Xcode workspace 选择 `alkaa` scheme 和 `iphonesimulator` 做 Debug 构建。 | 验证 Gradle 实际 JDK（项目 CI 使用 17）、Android SDK 36；iOS 需 macOS 和完整 Xcode。识别 APK、桌面分发目录和可定位的模拟器产物。不验收发布签名。 |
| `eligos` | 普通目录 workspace 中选择独立 Rust 项目（如 `eligos-core`、`fake-client`）做 Cargo 构建，或选 Tauri 项目（如 `eligos-livestream`）运行 Debug 构建，可用 `--no-bundle` 验证可执行产物。Tauri 的前端构建由其项目配置触发。 | Rust 项目检查 `protoc` 与关联输入；Tauri 检查 Node/pnpm、Rust 及平台 SDK。区分 Cargo 目标目录、前端 `dist` 和 Tauri 输出。Windows C# 和 Keil 不纳入。 |
| `homent-system` | 识别 Cargo workspace 子包 `homent-agent-server` 与 pnpm 子包 `@homent/web-ui`，分别构建，保留仓库自己的聚合命令。不运行设备或推送任务。 | 使用 workspace 声明和 mise 选定的工具；查看 Cargo 与 Web 输出。以包身份和相对路径区分不同系统和同名目标。 |
| `lone-singer-music` | pnpm workspace 分别选择 `apps/web › build`、`apps/server › build`，根聚合构建由项目命令负责。 | 使用 mise 声明的 Node `24.14.0` 和 pnpm `11.20.0`；区分两个包的运行记录和输出目录。 |
| `paseo-zeonest` | 从根 `package.json` 发现 npm scripts，验证 `npm run build`。`check` 等可能共享输出的任务与 `build` 排队。 | 检查 Node `>=22` 和 npm，观察 `client/`、`server/` 中的双端 bundle。 |
| `vofa_bridge` | 用户触发 CMake configure 后，从配置结果（如 CMake File API 的 codemodel）选 `example`、`player` 构建，不启动示例。 | 检查 C++20 编译器和 `fmt`，按配置查看构建目录的可执行产物。本地根清单未声明 `project()` 或 preset，须确认能否独立配置，或需选父工程提供的配置。 |

## 接入与验收要求

- 按 [仓库开发约定](../../AGENTS.md)、[架构](../../docs/architecture.md) 和 [子功能规范](../../docs/features.md) 接入。客户端用原生 `addWorkspacePanel`、React Native、Paseo 组件和主题；服务端负责发现、工具链解析、运行和存储。代码与行为测试放在 `features/build-workbench/`。构建适配逻辑只在该功能内复用，不新增壳层抽象或通用调度器。
- 使用锁定的 `@getpaseo/plugin@0.15.4`。服务端业务 RPC 同步声明在 `server/rpc.ts(x)`；功能关闭、启动失败或 cleanup 后拒绝业务。通过一元 RPC 和输出游标更新界面。POSIX 上 SDK 进程 helper 的 `kill` 只向直接子进程发送信号，停止语义需按平台管理和测试进程组或进程树。
- 用 fixtures 验证空目录、非法清单、子包同名目标、目标失效、被动发现不执行、工具缺失或变更、两个 workspace 的数据隔离和符号链接越界。用可控任务验证独立并行、输出冲突排队、停止不波及其他任务、失败与停止重试保留旧日志、截断提示及产物变化；用表中项目验证各类真实构建。缺少平台或工具时注明哪一项尚未验证。
- 运行 `npm run check`、`npm pack --dry-run --ignore-scripts`，对改动源码主动跑 LSP。真实 Paseo 检查宽屏与 compact、明暗主题、空状态和出错状态，验证「＋」入口、输出更新、停止与重试。未授权安装、启用或重载插件时记录待验项，不用 fixture 的结果替代真机验收。

## 参考

- Paseo v0.15.4 的[桌面 tab 栏「＋」](https://github.com/getpaseo/paseo/blob/v0.15.4/packages/app/src/screens/workspace/workspace-desktop-tabs-row.tsx#L232-L260)打开[新 tab 菜单](https://github.com/getpaseo/paseo/blob/v0.15.4/packages/app/src/screens/workspace/workspace-new-tab-menu.tsx#L51-L103)，其[目录](https://github.com/getpaseo/paseo/blob/v0.15.4/packages/app/src/workspace-tabs/launcher/index.tsx#L200-L251)包含同宿主且适用于当前 pane 的插件 workspace panel。[面板渲染器](https://github.com/getpaseo/paseo/blob/v0.15.4/packages/app/src/plugins/workspace-panels/panel.tsx#L36-L97)提供当前宿主和 workspace；该链路已核对版本源码，尚未做本功能的宿主验证。
- [Paseo v0.15.4 工作区文档](https://github.com/getpaseo/paseo/blob/v0.15.4/public-docs/workspaces.md)说明可把普通目录作为本地工作区。
- JetBrains 的 [Run configurations](https://www.jetbrains.com/help/idea/run-debug-configuration.html)、[npm 运行配置](https://www.jetbrains.com/help/idea/run-debug-configuration-npm.html)及 [Build 工具窗口](https://www.jetbrains.com/help/idea/build-sync-tool-window.html)提供命名配置、临时运行、任务输出、停止和重跑的交互参考。
