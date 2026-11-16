# Pi 设置

在 Paseo 左侧侧边栏提供「Pi 设置」页面，管理选定宿主上的 Pi 原生配置。也可从 Zeonest 功能配置入口进入；新增功能默认关闭，关闭时配置页面和支撑配置的 RPC 仍然可用。启用后的侧边栏与 Command Center 入口随 Zeonest 整体重载生效。

面向原生 MCP、托管 npm/git 目录和包命令的 **Pi 1.2.0+**，Paseo SDK 保持 **0.15.4**。不内嵌、安装或启动另一份 Pi SDK。页面的目录覆盖不改变 Paseo provider 启动 Pi 时使用的环境变量。

## 页面能力

按 [agegr/pi-web](https://github.com/agegr/pi-web) 的设置分区与列表/详情管理方式组织，调研基于 `174bff967807cdb59abb0204198d3d7cc19c862d`。这是使用 Paseo 原生 React Native Settings 和 Modal 重新实现的配置管理页，不导入参考项目的 Next.js 服务或浏览器组件。

| 分区 | 能力 |
| --- | --- |
| 配置范围 | 全局 / 所选宿主的项目工作区，包含工作区分页；使用工作区实际目录，worktree 配置不写回主仓库 |
| 模型 | 默认 provider、model、思考等级、启用模型模式；全局增删供应商和单个自定义模型，配置协议、地址、密钥引用、上下文窗口与输出上限；原始 JSON 支持 modelOverrides、费用和其他 Pi 原生选项 |
| 技能 | 发现、搜索、查看/编辑 SKILL.md；当前范围的加载规则和源文件的自动调用开关；通过 npm/git Pi 包安装技能，包更新/卸载在插件分区操作 |
| 插件 | 查看所选范围的 Pi 包、安装路径和版本；联网安装、检查并准备更新、卸载、启停；停用保存资源筛选备份，重新启用时还原；独立扩展只读查看和加载开关；Pi 内置扩展开关 |
| MCP | stdio / HTTP 服务器增删改、启停、exposure、完整 JSON 导入；可编辑 args、env、headers、oauth、toolExposure 等字段；显示全局继承与项目覆盖 |
| 页面设置 | diff 二次确认开关、agent 目录覆盖、Pi 可执行文件位置；无效偏好文件可显式修复 |

Pi **不支持项目级 `models.json`**。项目范围只编辑模型默认值、思考等级和启用范围，供应商文件仅在全局范围可编辑。项目 MCP 同名完整配置替换全局配置；没有传输字段的项目条目只覆盖 `enabled`、`exposure`、`toolExposure`。

资源发现读取 Pi 约定目录、配置路径/glob、包的 `pi` 清单或约定资源目录、`~/.agents/skills` 及工作区到仓库根之间的 `.agents/skills`。不会加载扩展工厂或调用 Pi 的可执行资源加载器。支持资源 `!glob`、`+exact-path`、`-exact-path`，以及包资源筛选；项目同身份包覆盖全局包，`autoload:false` 的项目筛选作为增量。扫描有数量/深度上限，异常会以警告显示，不能当作完整的运行时资源报告。

页面顶部的配置警告默认折叠，显示总数和首条的两行摘要。点击「展开全部」后可滚动查看完整列表，列表最高为宽屏 240、compact 180 个布局单位；点击「收起」恢复摘要。切换配置范围或 agent 目录后恢复折叠。操作失败的错误提示仍单独显示。

## 文件与配置生效

自动发现全局目录：宿主进程 `PI_CODING_AGENT_DIR`，否则 `~/.pi/agent`。可在页面设置中用绝对路径或 `~/` 覆盖。

- 全局：`<agent-dir>/settings.json`、`models.json`、`mcp.json`。
- 项目：`<workspace>/.pi/settings.json`、`.pi/mcp.json`。
- 技能编辑：用户当前选择、重新发现并校验过的源 SKILL.md。**编辑全局/包内技能影响使用该文件的所有项目**；仅希望项目停用时应使用「在当前范围加载此资源」，不要修改自动调用属性。
- 页面偏好：`<自动发现的默认 agent-dir>/zeonest-pi-settings.json`，不随目录覆盖搬迁。保存 diff 开关、可执行文件和停用包的原始筛选备份，不向 Pi settings.json 添加 UI 字段。
- 包文件：全局或项目对应的 `npm/`、`git/` 目录，使用 Pi 原生托管布局。本地路径资源只管理引用，不删除它们的源目录。

保存不会重启 daemon、中断 agent、自动信任项目或重新加载正在运行的 Pi 会话。之后在 Pi 中 `/reload` 或启动新会话，具体生效方式仍由 Pi 决定。项目配置只有在 Pi 认为该项目受信任时才加载；打开本页或写入配置不等于授予该信任。

settings/models 使用 JSONC 属性编辑保留无关字段、注释、缩进和换行；显式编辑原始文本按审阅过的字节写入。**mcp.json 必须使用 Pi 支持的标准 JSON**，不接受注释、BOM 或尾随逗号。无效文件显示错误及原文，不静默替换为空对象；不可读、过大或不安全的路径禁止写入。

## diff 与写入流程

所有正式配置写入都经过同一个 `prepare → preview → commit` 路径，包括普通保存、资源开关、技能内容/自动调用、供应商/MCP 增删、包声明及页面偏好。

1. 读取文件与内容 revision，解析并校验新内容；准备阶段不改正式配置。
2. 服务端保存精确的新旧文本，返回文件路径、unified diff、增删行数和一个随机确认 token。弹窗默认展开 diff；可以暂时隐藏，避免在共享屏幕中泄露密钥。
3. diff 二次确认默认开启。关闭它本身仍按**旧设置**确认；关闭后自动提交相同预检产生的 token，不绕过路径和并发校验。
4. 应用前再次检查目录、符号链接、文件 revision 和安装树内容指纹。其他客户端/进程已经修改文件时拒绝覆盖，保留草稿让用户重新读取。
5. 正式配置采用同目录临时文件与原子 rename；全局配置使用 0600，已有项目文件保留权限。多文件/安装树发生可捕获的中途失败时尝试回滚；回滚不覆盖后来出现的外部改动，不能完整回滚时明确报告需人工恢复的路径。

预览有效期 20 分钟，最多 8 项；取消、过期及正常插件关闭会清理暂存。普通文本上限 1 MiB，完整配置 diff 上限 2 MB。全局和配置根允许显式设置的目录链接，但配置文件链接不能离开授权根；项目 `.pi` 不能链接出工作区。包暂存拒绝指向安装树之外的链接、特殊文件和超过限制的安装目录（10 万项、总计 512 MiB、单文件 64 MiB）。

配置文件与安装目录不是一个跨文件系统事务；系统崩溃或强制终止时不承诺整体原子性。Zeonest 写入者通过临时目录中的 canonical-path 锁互斥，Pi CLI 和外部编辑器不参与这把锁，极窄的外部写入竞态仍然存在。异常退出后可检查目标目录中的 `.zeonest-backup-*` 和 `.zeonest-incoming-*`，确认没有活动操作后再人工恢复/清理；不要盲目删除其他进程的锁。

## 联网安装和安全边界

页面中的「下载并准备安装」「检查 / 更新」「准备卸载」在临时目录运行宿主的 Pi 包命令。它们只把所选包声明及对应托管安装目录放入暂存 agent，使用空项目目录；不会复制 auth.json、mcp-auth.json 或加载全局扩展。

- 使用 argv 数组执行，不经 shell；只接受 `npm:`、`git:` 和 HTTPS Git 源。不会调用 Pi 自更新命令。
- npm 生命周期脚本通过命令参数及环境变量禁用；不使用用户 settings.json 中的自定义 npm wrapper。
- Git 安装/更新重新克隆目标仓库，不执行旧安装目录中的 Git hooks 或本地仓库配置。
- 完成下载后展示 Pi 配置文件及 npm 根 manifest/lockfile 的完整文本 diff；下载的代码、依赖和 Git 元数据以安装目录增/删/改数量汇总，**不是逐个代码文件审计**。
- 确认后才提升安装目录并写入包声明。取消不会修改正式 Pi 配置或安装目录。固定 npm 版本不会隐式跳到最新版；需要改源版本后重新安装。
- 进程默认限时 3 分钟；插件关闭时终止操作，POSIX 系统同时终止子进程组。

暂存是写入流程隔离，**不是安全沙箱**。Pi/npm/git 仍具有 daemon 用户的系统权限，可能访问宿主的 registry/Git 凭据和网络。下载的插件/技能在未来由 Pi 加载时也拥有 Pi 的完整权限。需要安装脚本的包可能无法工作，本页面不会自动降级成执行脚本。

相较参考页面，本实现不提供 provider 登录、凭据刷新、模型在线连通性测试、技能市场检索、MCP 连接测试/工具调用/OAuth 登录等运行时流程；认证仍使用 Pi 原生 CLI/TUI。可配置 MCP OAuth 字段，但不读取或修改 token 文件。非标准 MCP 适配器的私有配置不在管理范围。旧式 npm 全局安装目录仅显示为未托管，不会擅自卸载系统级 npm 包。

## 代码入口

- `client/index.ts`：可关闭的原生侧边栏、screen、Command Center 注册。
- `client/settings.tsx`：始终可用的 Zeonest 子功能配置入口。
- `client/page.tsx`、`components.tsx`：原生设置页、编辑器与 diff Modal。
- `server/settings.ts`：始终可用的配置 RPC，惰性创建服务并清理资源。
- `server/service.ts`、`files.ts`、`discovery.ts`：配置预检/提交、文件事务、资源发现与包暂存。
- `shared/`：RPC/schema 和纯配置文本处理；不依赖壳或其他子功能。

运行依赖 `diff`、`jsonc-parser`、`minimatch`、`yaml` 随 bundle 打包；React/Paseo/Zod 保持宿主 external。React test renderer 仅用于功能 UI 行为测试，不进入运行包。

## 验证

```bash
npm run check
npm pack --dry-run --ignore-scripts

# 可选的真实 Pi CLI 契约测试（只使用临时 agent 与 localhost 测试 registry）
ZEONEST_PI_CLI=/absolute/path/to/pi/dist/cli.js \
  node --import tsx --test features/pi-settings/tests/package-cli.test.ts
```

自动化覆盖：配置 diff/确认开关、取消/过期不写入、冲突拒写、项目隔离、MCP 继承、JSONC/未知字段保留、技能 YAML、资源规则、包筛选备份、安装目录暂存及回滚、服务 teardown、分页、真实 React 保存/取消/失败交互、模型编辑、警告折叠/限高/范围切换及主题 token。

开发时在 macOS / Node 26.12.0 / Pi 1.2.0 上执行了真实 CLI 的 npm 安装/更新/卸载契约测试，使用仅有测试 fixture 的本地 registry，验证安装脚本与扩展均未运行；不修改正式 Pi 配置。常规 `npm run check` 在未设置 `ZEONEST_PI_CLI` 时显式跳过此宿主相关测试。Git 远端、需要构建脚本的第三方包、Windows/Linux 未实机验证。

主动 LSP 探测时多数 TS/TSX 文件没有可用的 language client；不将空诊断缓存视为通过，使用统一 TypeScript 检查和构建补充验证。

**未安装、启用或重载插件；未执行真实 Paseo 的宽屏、compact/mobile、明暗主题及出错状态验收。** React/主题 token 测试不替代真实宿主检查。获准安装后应额外检查：侧边栏选定宿主、工作区目录/继承提示、窄屏编辑器、包含密钥的 diff、双客户端冲突、断线、取消安装、停用后仍能打开配置，以及 `/reload` 后 Pi 的实际加载结果。
