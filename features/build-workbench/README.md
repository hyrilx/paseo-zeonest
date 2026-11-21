# 工作台：构建

在工作区发现构建目标、选择工具链，并查看独立的运行输出和产物。

功能默认关闭。启用后，从 Paseo 工作区 tab 栏的「＋」打开。选择目标，在「工具链」中检查所选工具，再核对命令和工作目录。关闭 tab 不会停止任务；重开后可以继续查看同一工作区的记录。

发现目标只读工作区清单。构建以 daemon 用户权限运行，只在信任项目代码时启动；路径校验不等于沙盒。任务状态、配置和有界日志保存在宿主 `PASEO_HOME/zeonest/build-workbench/`，不会存储整个环境；项目输出的敏感内容仍可能进入日志。产物保留在工作区，列表表示构建前后的观察结果，不证明文件来源。停止支持 POSIX 进程组；自行脱离进程组的程序不受此机制控制。

## 验收记录

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

- 从普通目录分别发现 `eligos-core`、`fake-client`。两个 `build.rs` 引用的四个 `.proto` 均在工作区内；它们会生成 `src/protos`。当前没有可用的 `protoc`，工作台在启动前阻止构建，未写入原项目。测试覆盖了越界输入被拒绝和源码生成目录被识别。
- 发现 `eligos-livestream` 的 Tauri Debug `--no-bundle` 目标，分别观察前端 `dist` 和 `src-tauri/target/debug/eligos-livestream`。系统可定位 macOS SDK，但样本缺少 `node_modules/.bin/tauri`，没有安装前端依赖或执行 Tauri 构建。真实 Rust 生成与 Tauri 可执行文件均待验。

### alkaa

- 静态发现 Gradle `:app:assembleDebug`、`:desktop-app:createDistributable`，以及 `ios-app/alkaa.xcworkspace` 中的共享 scheme `alkaa`。已安装的 Temurin 17 通过 Java 版本检查，但缺少项目所需的 Gradle `9.5.1-all` Wrapper 缓存，未启动 Wrapper 或触发下载。Android SDK 当前只有 `android-37.0` 平台，项目要求 `android-36`。
- `xcode-select -p` 指向 `/Library/Developer/CommandLineTools`，没有完整 Xcode。该 scheme 的现有构建阶段会调用 Gradle 生成 Kotlin 框架。真实 Gradle launcher/daemon JVM、APK、桌面分发目录及 iOS 模拟器产物均待验；未运行签名、设备或发布任务。
- Fixture 覆盖了 Wrapper 缓存与 SDK 检查、显式枚举后确认当前工作区已声明的目标、APK 路径，以及 Xcode 的 Debug 模拟器参数、禁用签名和 `.app` 产物观察。
