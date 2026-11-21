# 工作台：构建

在工作区发现构建目标、选择工具链，并查看独立的运行输出和产物。

功能默认关闭。启用后，从 Paseo 工作区 tab 栏的「＋」打开。选择目标，在「工具链」中检查所选工具，再核对命令和工作目录。关闭 tab 不会停止任务；重开后可以继续查看同一工作区的记录。

发现和预览只读工作区文件。主动探测或运行后，项目工具可以下载 Gradle Wrapper、解析 Cargo crates 或 Swift packages 等依赖。npm/pnpm 的直接依赖缺失、版本不符或安装记录早于锁文件时，预览会列出安装命令。安装失败或被停止时不会启动构建；从该条记录重试会重新安装，即使留下了部分 `node_modules`。工具候选包含宿主 PATH 和已有 mise 安装，例如 CMake 应用包、`protobuf` 提供的 `protoc`。

构建以 daemon 用户权限运行，只在信任项目代码时启动；路径校验不等于沙盒。任务状态、配置和有界日志保存在宿主 `PASEO_HOME/zeonest/build-workbench/`，不会存储整个环境；项目输出的敏感内容仍可能进入日志。产物保留在工作区，列表表示构建前后的观察结果，不证明文件来源。停止支持 POSIX 进程组；自行脱离进程组的程序不受此机制控制。

## 适配范围

| 技术栈 | 发现与构建 |
| --- | --- |
| npm/pnpm | 从 `package.json` 和 workspace 声明发现脚本；构建选项传给所选脚本，例如 `--mode staging`。 |
| Cargo | 从 `Cargo.toml` 发现 crate 和 workspace 成员；支持 `--release`、`--profile ci`、`--features "ui fast"`、`--target`。`build.rs` 和依赖由 Cargo 处理。 |
| CMake | 先 configure，再从 File API 选择目标。配置时可选 preset 或传 `-G`、`-D`；构建时可用 `--config Release --parallel 4`。未指定生成器时沿用 preset、环境或 CMake 默认值。 |
| Tauri | 从 JSON、JSON5 或 TOML 配置识别项目；用项目的 JS CLI 或已安装的 `cargo-tauri` 构建。默认 Debug，可选 `--release`、`--features`、`--target` 和局部配置文件；保持 `--no-bundle`。 |
| Gradle | 用 Wrapper 或已安装 Gradle 执行 `tasks --all`，在目标列表选择 `assembleDemoRelease` 等 variant 任务，也可填 `-Pchannel=staging --max-workers 4`。不覆盖项目的 Kotlin 编译策略。 |
| Xcode | 从 workspace 或独立工程查询 scheme；有多个本地 Xcode 时可选安装。支持 `-configuration Release`、`-arch` 等模拟器选项；构建始终禁用签名。 |

选项栏支持引号和反斜杠，例如 `--label "two words"`。预览显示实际参数和准备步骤；工作台不会将它们拼成 shell 命令。

脚本产物使用清单线索、已存在的常见输出目录或手动输入的相对路径；这些线索不用于放开并发。项目名、示例模块、构建钩子和 SDK 版本不作为适配条件。

## 验收记录

### 通用适配回归

- 用隔离的 Groovy/Java 工程和空 `GRADLE_USER_HOME` 运行真实 Wrapper：首次探测下载 Gradle `9.5.1-all` 并枚举任务；随后用 mise Temurin `17.0.21` 执行 `:compileJava`，成功观察到 `Sample.class`。另用 fixture 覆盖非 `:app` 的嵌套模块与项目自选 JDK。
- 用不含 mise 的 PATH 启动服务，从 mise 安装发现 CMake `4.5.1`、Ninja `1.13.2` 和 `protobuf` 的 `protoc 36.2`。CMake 在找不到一个可选依赖时仍从 RelWithDebInfo preset 的 File API 发现并构建目标；Cargo fixture 的 `build.rs` 成功调用 `protoc` 生成描述文件。
- 用隔离的真实 Gradle 工程枚举并运行 `:assembleDemoRelease -Pchannel=staging --max-workers 2`，确认任务收到 `staging` 并成功退出；该 fixture 不是 Android APK 构建。用新目录重跑了 CMake preset，Cargo 也通过复验。
- Fixture 覆盖 npm 安装失败、pnpm 安装中断后留下部分包文件的情况：重启工作台后重试仍会先安装再构建。另覆盖锁文件更新、包版本不符和 pnpm PnP，以及多套 Xcode、Tauri Rust 候选和可选工具不阻断版本检查。
- 在浏览器替身检查宽屏常用选项和 compact 深色下的带引号参数预览。未在原样本仓库安装依赖或修改配置。

### paseo-zeonest

- 当前任务 worktree：从根 `package.json` 发现 `build` 和 `check`。经工作台服务检查 Node `v26.13.1`、npm `11.20.0` 后启动 `npm run build`，退出码为 `0`，观察到 `client/`、`server/` 下的 `bundle.js` 和 `bundle.d.ts` 变化。构建期间提交 `check`，状态为排队，在启动前取消；两个脚本所在工作区的写入范围按未知处理。
- Fixture 验证了两个工作区独立并行、同根排队、停止进程组不影响另一任务、跨工作区拒绝访问、旧记录保留、日志截断、路径越界拒绝与变更后重试确认。
- 用 agent-browser 检查面板源码的浏览器替身：宽屏浅色、compact 深色、命令预览、产物、空清单与 RPC 断开；重新检查了 compact 详情的返回按钮。未安装、启用或重载插件。Paseo `0.16.2` 中的实际「＋」入口、宽屏与 compact 的明暗主题、空状态与出错状态，以及输出更新、停止与重试仍待实机验收。

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

- 该样本待验证 Gradle `:app:assembleDebug`、`:desktop-app:createDistributable`，以及 `ios-app/alkaa.xcworkspace` 的 `alkaa` scheme。首轮因 Wrapper 未缓存而没有运行；该限制已移除，冷 Wrapper 下载在隔离工程通过。样本检查时 Android SDK 只有 `android-37.0` 平台，项目需要 `android-36`。
- `xcode-select -p` 指向 `/Library/Developer/CommandLineTools`，没有完整 Xcode。该 scheme 的现有构建阶段会调用 Gradle 生成 Kotlin 框架。真实 Gradle launcher/daemon JVM、APK、桌面分发目录及 iOS 模拟器产物均待验；未运行签名、设备或发布任务。
- Xcode fixture 验证了 scheme 枚举、Debug 模拟器参数、禁用签名和 `.app` 产物观察。
