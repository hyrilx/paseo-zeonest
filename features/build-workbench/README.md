# 工作台：构建

在工作区发现构建目标、选择工具链，并查看独立的运行输出和产物。

功能默认关闭。启用后，从 Paseo 工作区 tab 栏的「＋」打开。选择目标，在「工具链」中检查所选工具，再核对命令和工作目录。关闭 tab 不会停止任务；重开后可以继续查看同一工作区的记录。

发现和预览不执行项目命令。主动探测或运行后，项目工具可以下载 Gradle Wrapper、解析 Cargo crates 或 Swift packages 等依赖。npm/pnpm workspace 和有依赖声明的包在运行时先执行原生 `install`，由包管理器按自己的锁文件、配置和缓存决定复用或安装。预览列出安装根和命令；安装失败或被停止即结束本次任务。再次运行或重试都不会因残留 `node_modules` 或 PnP 文件跳过准备。工具候选包含宿主 PATH 和已有 mise 安装，例如 CMake 应用包、`protobuf` 提供的 `protoc`。

构建以 daemon 用户权限运行，只在信任项目代码时启动；路径校验不等于沙盒。任务状态、配置和有界日志保存在宿主 `PASEO_HOME/zeonest/build-workbench/`，不会存储整个环境；项目输出的敏感内容仍可能进入日志。产物保留在工作区，列表表示构建前后的观察结果，不证明文件来源。停止支持 POSIX 进程组；自行脱离进程组的程序不受此机制控制。

## 适配范围

| 技术栈 | 发现与构建 |
| --- | --- |
| npm/pnpm | 按各自 workspace 成员规则选择包和安装根；pnpm 未声明 `packages` 时只包含根包。选项传给脚本，例如 `--mode staging` 由脚本解释。 |
| Cargo | 从实际启动目录读取配置、TOML `include` 和输出目录环境变量。识别 workspace 显式成员及根内路径依赖，支持 Rust `channel` / `path` 固定、profile、features 和 target。声明的编译器与所选工具不同时拒绝启动；产物由 Cargo 报告。 |
| CMake | 先 configure，再从 File API 选择目标。更换工具或 configure 参数使用独立构建目录；File API 列出的配置输入（含外部文件）变化后重新配置。支持 `--config Release --parallel 4`；留空时使用 CMake 默认值。 |
| Tauri | 显式绑定可确认的 Rust 应用和前端目录，包括非 `src-tauri` 布局。使用所选 Rust 工具及项目 JS CLI 或已选 `cargo-tauri`；绑定冲突或项目 CLI 缺失时不换用其他 CLI。默认 Debug，可选 `--release`、features 和 target，保持 `--no-bundle`。 |
| Gradle | 用 Wrapper 或已安装 Gradle 枚举原生任务，包括自定义组。探测与运行须使用同一工具及相同顺序的全局选项，例如 `--offline --parallel`。截断时用 `--workbench-task-filter=:模块:` 补查；任务执行专属选项不参与探测匹配。启动前确认任务实际行为。 |
| Xcode | 从 workspace 或独立工程查询 scheme；有多个本地 Xcode 时可选安装。`-configuration` 留空使用 scheme 默认，仅构建无签名 iOS 模拟器产物。 |

选项栏支持引号和反斜杠，例如 `--label "two words"`。预览显示参数、准备步骤和工具环境调整。切换目标会清空临时选项和手填产物路径，可以主动复制 Gradle 探测参数。

同一 daemon 的工作区指向同一个实际 Gradle 项目目录时，可以共享已确认的任务。只有可追踪的声明（简单的字面模块声明和内建插件）与可确认的已安装 Gradle/JDK 组合才写入共享缓存。Wrapper、自定义 catalog、`apply`、动态项目配置、无法确认的初始化脚本和 JVM 设置等仍可探测，但结果仅在发起工作区的当前会话用一次。

共享缓存位于 `PASEO_HOME/zeonest/build-workbench/gradle-tasks/`，保存任务名及上下文摘要；另一工作区要自行输入匹配的选项，或使用自己的保存配置。原始 `-P`/`-D`、选项复制、日志和运行历史只对发起工作区可见。共享结果在重启工作台或淘汰历史后仍可复用；声明、工具或环境变化后重新探测。失败与停止不会替换有效结果；旧格式缓存不再读取。

产物优先使用 Cargo 或 CMake 原生报告。Gradle、Tauri 和 Xcode 未取得原生路径时可手填要观察的目录；`dist/` 等仅作线索。已知的外部 Cargo/CMake 写入位置仍参与冲突排队，不能在面板浏览。项目名和验收样本的构建钩子不作为适配条件。

静态扫描有深度和目标数量上限。Gradle 的嵌套独立工程用自己的 `settings.gradle[.kts]` 标识；父工程内只有 build 文件的目录不另列为根。CMake 支持扫描范围内的嵌套入口和可读的 configure preset；不展开动态 preset 引用、不运行 build preset 或未确认的自定义目标。暂不覆盖非 iOS Xcode SDK。npm/pnpm 分别核验安装根和脚本包的版本声明；检测到另选 Node 的项目、用户或宿主设置时拒绝验证，不尝试切换。pnpm 展示候选版本，不保证自定义脚本不会自行选择别的运行时。

## 验收记录

### 通用适配回归

- 用隔离的 Groovy/Java 工程和空 `GRADLE_USER_HOME` 运行真实 Wrapper：首次探测下载 Gradle `9.5.1-all` 并枚举任务；随后用 mise Temurin `17.0.21` 执行 `:compileJava`，成功观察到 `Sample.class`。另用 fixture 覆盖非 `:app` 的嵌套模块与项目自选 JDK。
- 用不含 mise 的 PATH 启动服务，从 mise 安装发现 CMake `4.5.1`、Ninja `1.13.2` 和 `protobuf` 的 `protoc 36.2`。CMake 在找不到一个可选依赖时仍从 RelWithDebInfo preset 的 File API 发现并构建目标；Cargo fixture 的 `build.rs` 成功调用 `protoc` 生成描述文件。
- 用隔离的真实 Gradle 工程枚举并运行 `:assembleDemoRelease -Pchannel=staging --max-workers 2`，确认任务收到 `staging` 并成功退出；该 fixture 不是 Android APK 构建。用新目录重跑了 CMake preset，Cargo 也通过复验。
- Fixture 覆盖 npm 失败、pnpm 被停止后的部分安装：再次运行和重启后重试都先准备，不把锁文件、包版本或 PnP 当作就绪证明。另覆盖多套 Xcode、scheme 变更、Tauri 的实际 Node/Cargo 子进程解析、mise 补充 `protoc` 时不覆盖 `cc`，以及跨工作区共享 Cargo 输出排队。
- Gradle fixture 的 `tasks --all` 输出超过 256 KiB，且包含 600 多个候选。日志滚动后，刷新列表仍可选择并预览尾部的 `:app:assembleDebug` 和 `:desktop-app:createDistributable`。达到单次 256 项和工作区 512 项上限时，面板显示裁剪提示；退出失败、无法解析或取消均保留先前有效的结果。
- Gradle 缓存 fixture 覆盖同目录共享、独立 checkout 隔离、重启、历史淘汰、发起方选项复制，以及声明、JDK、发行版与用户 init 变化后的失效。验证共享文件及另一工作区的发现响应不含原始选项，旧格式不被读取。用已安装的 Gradle `9.5.1`、Temurin `17.0.21` 离线复验：静态工程跨工作区并在重启后复用，自定义 catalog 仅当次使用；修改 `variants.toml` 后新探测返回 Green 而非 Blue；缺少 `--parallel` 无法运行只在该选项下注册的任务。
- 终审复验使用隔离目录：pnpm `12.21.0` 原生命令和工作台对缺失 `packages`、brace、排除规则的成员判断一致；原生安装后脚本使用所选 Node `v26.13.1`。Cargo `1.100.0` 使用固定路径工具链编译隐式成员，原生报告根配置指定的 `outer-output/debug/native-product`，未使用成员目录的配置。
- Gradle `9.5.1` 离线枚举自定义 `renderAssets`；`conditionalRender` 只在 `-Pchannel=prod` 的上下文可运行。CMake `4.5.1` + Ninja Multi-Config 在留空时生成 `Release/portable`，显式 Debug 生成 `Debug/portable`；被包含的 `.cmake` 文件变动后必须重新配置，切换 Unix Makefiles 使用不同目录。
- 本轮另用真实 CMake `4.5.1` 在两个隔离 checkout 读取相对和绝对外部 include，以默认 Release 和显式 Debug 生成外部产物，修改外部文件后旧目标失效。真实 Cargo `1.100.0` 的 `metadata` 和离线构建使用 `include` 指定的共享目标及中间目录。两种共享输出的排队以 fixture 验证；外部产物均未对面板开放。pnpm `12.21.0` 复验原生安装和脚本使用绑定的 Node。Tauri 应用引用与 Xcode scheme 以替身测试，未运行真实 Tauri/Xcode 构建。
- 未在原样本仓库安装依赖或修改配置。

### paseo-zeonest

- 当前任务 worktree：从根 `package.json` 发现 `build` 和 `check`。经工作台服务检查 Node `v26.13.1`、npm `11.20.0` 后启动 `npm run build`，退出码为 `0`，观察到 `client/`、`server/` 下的 `bundle.js` 和 `bundle.d.ts` 变化。构建期间提交 `check`，状态为排队，在启动前取消；两个脚本所在工作区的写入范围按未知处理。
- Fixture 验证了两个工作区独立并行、同根排队、停止进程组不影响另一任务、跨工作区拒绝访问、旧记录保留、日志截断、路径越界拒绝与变更后重试确认。
- 用 agent-browser 检查面板源码的浏览器替身：宽屏浅色、compact 深色、命令预览、产物、空清单与 RPC 断开；重新检查了 compact 详情的返回按钮，以及复制 Gradle 探测选项、运行前确认和换目标后清空选项与手填路径。未安装、启用或重载插件。Paseo `0.16.2` 中的实际「＋」入口、宽屏与 compact 的明暗主题、空状态与出错状态，以及输出更新、停止与重试仍待实机验收。

### homent-system

- 工作台依 `Cargo.toml` 的成员声明发现 `crates/homent-agent-server`。用已经安装的 Cargo 和 rustc `1.100.0` 离线构建，退出码为 `0`；观察到 `target/debug/homent-agent-server` 和 `target/debug/libhoment_agent_server.rlib` 变化。
- 从 `pnpm-workspace.yaml` 发现 `apps/homent-web-ui`（`@homent/web-ui`），选择已安装的 mise Node `v26.13.1`、项目声明的 pnpm `11.3.0`，构建退出码为 `0`；观察到 `apps/homent-web-ui/dist` 的入口和资源变化。根聚合 `build` 作为独立目标预览，未重复运行。此样本没有仓库级 mise 配置。

### lone-singer-music

- 从 pnpm workspace 区分根聚合 `build`、`apps/web › build` 与 `apps/server › build`。检查并选择 `mise.toml` 指定的 Node `v24.14.0`、pnpm `11.20.0`，同时校验根清单的 engines 范围。
- 经工作台分别启动 Web（Vite）和服务端（tsup），两次退出码均为 `0`。观察到 `apps/web/dist/index.html` 及资源、`apps/server/dist/main.js` 及 sourcemap 变化。两个脚本的写入范围均按未知处理，不在同一工作区并发运行；未启动服务或设备。

### vofa_bridge

- 在保留当前检出内容的临时副本显式配置。CMake `4.5.1` / Ninja `1.13.2` 识别 Apple Clang `21.0.0`，但顶层没有 `project()` 和 `cmake_minimum_required()`，CMake 因后者退出 `1`，并报告找不到 `fmt`。未就地修改清单或补装依赖；原项目的 `example`、`player` 尚未构建成功。
- 同一工具链在独立 C++20 fixture 中配置成功，从 File API 发现 `example` 和 `player`，两项均成功链接，产物视图分别标记两个可执行文件为新增。未启动任何示例。

### eligos

- 从普通目录分别发现 `eligos-core`、`fake-client`。两个 `build.rs` 引用的四个 `.proto` 均在工作区内；它们会生成 `src/protos`。首轮未运行源码生成；通用适配已可从 mise 定位 `protoc`，由实际构建脚本处理输入和生成目录。尚未在隔离副本重跑该样本。
- 发现 `eligos-livestream` 的 Tauri Debug `--no-bundle` 目标，分别观察前端 `dist` 和 `src-tauri/target/debug/eligos-livestream`。系统可定位 macOS SDK；首轮没有安装该样本的前端依赖，也没有执行 Tauri 构建。真实 Rust 生成与 Tauri 可执行文件均待验。

### alkaa

- 从 Alkaa `8524e062` 导出隔离副本，用临时 Gradle 缓存、Wrapper `9.5.1`、mise Temurin `17.0.21.1` 和本机 Android SDK 36 执行 `tasks --all --offline`。原生命令输出约 810 KB；工作台探测成功、保留 256 个目标并标记为部分结果。刷新后可选择并预览 `:app:assembleDebug` 和 `:desktop-app:createDistributable`，没有运行这两个构建任务，也未修改 Alkaa 的原检出。
- `xcode-select -p` 指向 `/Library/Developer/CommandLineTools`，没有完整 Xcode。`ios-app/alkaa.xcworkspace` 的 `alkaa` scheme 会调用 Gradle 生成 Kotlin 框架。APK、桌面分发目录及 iOS 模拟器产物仍待验；未运行签名、设备或发布任务。
- Xcode fixture 验证了 scheme 枚举、Debug 模拟器参数、禁用签名和 `.app` 产物观察。
