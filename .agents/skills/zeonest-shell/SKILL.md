---
name: zeonest-shell
description: 维护 Zeonest 的最小 Paseo 容器外壳、原生功能管理页、持久化开关、静态集成工具和启动快照。必须使用 zeonest-git 管理任务分支、worktree、逐轮提交、远端同步及合并后清理。已获授权在独立预览宿主通过 paseo plugin update zeonest --ref 与浏览器完成端到端测试和视觉验收，涉及 UI 时还须结合前端技能。
---

# Zeonest 外壳维护

先读仓库根目录的 `AGENTS.md`、`docs/architecture.md`、`docs/development.md`。本 skill 所在目录向上三级为仓库根目录。

开始修改前，必须加载并遵循 [Git 协作技能](../zeonest-git/SKILL.md)，先确定任务分支和独立 worktree；每轮有改动的对话独立提交，获授权合入主干时将整个任务 squash 为一个提交，默认推送 main 并同步开发分支；合入过程复用已有独立 worktree 与有效验证结果，按实际改动补充检查。后续开发、验证和提交均在自己的 worktree 中执行；主干合并推送、开发分支处理完成后，必须核对并移除本任务创建的 worktree。

## 保持职责

外壳仅负责功能信息、host 级开关、整体重载时静态组合原生贡献，以及配置入口。子功能内部完全内聚，不增加 Zeonest 业务 SDK。

## 修改流程

1. 读取 `shell/client`、`shell/server`、`shell/shared` 中受影响源码与根 tests，确认是壳职责。features/<id> 内的业务不搬进壳；不得要求新功能维护根清单。
2. 配置界面只通过 Paseo 原生 `addSettingsScreen` 注册一个「功能集」（`zeonest-features`）。子功能配置在该页内部切换，原样传递宿主 `PluginSurfaceProps`，提供「返回功能集」操作；不逐个注册顶层设置入口。UI 使用原生 Settings 组件，不复制宿主设置框架。
3. 区分保存的期望开关和本次服务端运行快照。新客户端必须跟随运行快照，不能提前启用待重载功能。
4. 整体重载后生效，不增加热启停或运行时动态注入。
5. 配置页和支撑配置的原生服务端注册始终可用；壳不得读取或重置子功能配置。服务端可选 `rpc.ts(x)` 必须在同步贡献返回前执行，以进入 0.15.4 的固定 RPC 目录；它仍是原生贡献，由功能内部拒绝未启用/已停止时的业务调用。不得包装原生 context 或把业务状态放入壳。
6. 异步启动在 cleanup 后不得复活。cleanup 倒序、幂等，单项失败不跳过后续清理。
7. 主动处理 loading、invalid、error、revision 冲突、待生效状态、空功能集和主题/compact。
8. 统一构建按稳定排序扫描 features，在内存生成静态 imports/元信息/原生贡献表，输出根 client/server 的 bundle 与原生声明；产物不提交，输出目录不放手写代码。根原生入口保持固定薄重导出，SDK/React/React Native/Zod 等宿主模块 external。
9. 保留源级运行端检查，覆盖 type-only、类型引用、传递声明及真实运行依赖；禁止跨功能/功能依赖壳 helper、运行代码依赖测试/fixtures 或仓库根 tools（本端业务 tools 子目录可用），shared 不能依赖 Node/React/端专用 SDK。产物检查不能替代源码检查。
10. 同步文档与测试，执行 `npm run check`、主动 LSP 与打包清单检查。验证源码显式准备与预构建包无开发依赖的准备分支，不保留调用缺失工具的打包准备步骤。
11. 升级 SDK 时同步 manifest 最低版本并核对 daemon 与客户端。不凭在线文档假定未发布 API 已可用。

## 独立预览宿主验收（已获授权）

已获长期授权在以下**独立预览宿主**上更新 `zeonest` 并在浏览器内完成端到端测试与视觉验收，无需每轮再次申请该宿主的更新与重载权限：

- 预览宿主目录（`--home`）：`~/.paseo-zeonest-preview`（`$HOME/.paseo-zeonest-preview`）
- 监听地址与 Web UI：`http://127.0.0.1:6799`（Zeonest 设置页：`http://127.0.0.1:6799/settings/hosts/srv_ac1vmF5PAK5F/plugins/zeonest`）
- 预期 `serverId`：`srv_ac1vmF5PAK5F`
- 插件来源：本地 Git 仓库 `git:file:///Users/hyrilx/02-dev/paseo-zeonest`（Paseo 检出到预览宿主自身目录并独立构建，不绑定任务 worktree 路径）

执行流程与防误操作护栏：

1. **先本地提交再更新**：`paseo plugin update zeonest --ref` 读取本地 Git 仓库中的指定提交对象（所有 linked worktree 共享对象库），不会读取未提交改动；无需合入 `main`，也无需推送远端。
2. **清理环境并核对宿主身份**：每次执行 CLI 前必须 `unset PASEO_HOME PASEO_HOST` 并显式传入 `--home "$HOME/.paseo-zeonest-preview"`，先确认 `paseo daemon status --home "$HOME/.paseo-zeonest-preview" --json` 返回 `localDaemon == "running"`、`serverId == "srv_ac1vmF5PAK5F"`、`listen == "127.0.0.1:6799"`。若预览宿主未运行、`serverId` 不匹配或 `zeonest` 未按本地 Git 源安装，**立即停止并报告阻塞**，不得回退到日常宿主，不得擅自修改 `pluginsEnabled` 或启动/重启任何 daemon。
3. **按完整 SHA 更新并校验运行态**：
   ```bash
   unset PASEO_HOME PASEO_HOST
   preview="$HOME/.paseo-zeonest-preview"
   ref="$(git rev-parse HEAD)"
   test "$(paseo daemon status --home "$preview" --json | jq -r .serverId)" = srv_ac1vmF5PAK5F
   paseo plugin update zeonest --ref "$ref" --home "$preview" --json
   paseo plugin ls zeonest --home "$preview" --json
   ```
   确认输出中 `status == "running"` 且 `installation.currentRevision == "$ref"`；需要排查问题时可查看 `paseo plugin logs zeonest --home "$preview"`。
4. **在浏览器内完成端到端验收**：在浏览器打开 `http://127.0.0.1:6799/settings/hosts/srv_ac1vmF5PAK5F/plugins/zeonest`，按改动范围验证功能集搜索与展示、子功能配置页切换与返回滚动恢复、开关保存与待生效提示、自重载按钮仅重载预览宿主、运行快照隔离以及错误/冲突提示。
5. **回退与数据隔离**：需要对照基线或回退版本时，对预览宿主再次执行 `paseo plugin update zeonest --ref <目标SHA> --home "$preview"` 即可。预览宿主只隔离 Paseo 会话与插件设置，**不隔离同一操作系统用户的文件系统**；验收涉及文件或外部状态时使用独立临时目录和样例数据，不得改动用户日常数据。
6. **严格区分日常宿主**：日常宿主（`~/.paseo`）始终不在本许可范围内；未经用户明确授权，绝不对其安装、更新、启停或重载插件，不修改其 `pluginsEnabled`，不重启任何 daemon。

## UI 开发与验收（涉及界面时必做）

1. 新增或修改可见界面、布局、样式或交互时，实现前必须加载并使用相关前端 skill。布局与视觉设计加载 `design-taste-frontend`，动画等专项按实际技术栈补充对应技能；在交付说明中列出使用的技能。
2. 前端技能用于指导视觉层级、间距、可访问性和交互反馈。实现遵守本仓库的 React Native、Paseo 原生组件、主题 token、compact 与 SDK 边界，不照搬网站模板、品牌配色或 DOM/CSS 示例，不为套用技能引入新依赖。本仓库的浏览器辅助开发与验收必须使用浏览器自动化工具（`agent_browser` 或当前环境提供的原生浏览器工具），通用技能的检查脚本不能替代它。
3. 开发开始时可先在独立预览宿主（`http://127.0.0.1:6799/`）查看现状并截图。完成首轮实现与本地提交后，按上文流程将预览宿主更新到当前 `HEAD` SHA，在浏览器内检查实际渲染与交互；每轮视觉修正后重新提交、更新预览宿主并复验。必须打开截图检查像素结果，不能只读源码、DOM 或可访问性快照。仅当预览宿主确实不可用时，才退回渲染真实组件的本地预览辅助开发，并记录 mock 范围与真实 Paseo 验收阻塞项。
4. 使用原生浏览器工具（如 `agent_browser` 或宿主提供的 `browser_*` 工具，不经 bash 调用）：打开页面后先获取交互快照（如 `snapshot -i`），按当前 refs 操作，导航或 DOM 变化后重新快照；截图后核对产物验证结果并读取图像。截图存临时目录，不提交个人运行数据。
5. 完成前在独立预览宿主的浏览器中验收宽屏/compact 与明/暗主题组合，并覆盖本次 UI 涉及的 loading、空数据、错误、长文本、滚动、键盘焦点与主要操作反馈。发现溢出、遮挡、对比不足、触控目标过小或状态反馈不清时，修正后重新提交、更新预览宿主、截图与复验。类型、单元测试和构建通过不能代替视觉验收。
6. 交付时记录预览宿主版本、已更新的提交 SHA、预览访问地址、视口尺寸、主题、已验证的状态与操作、截图路径及未解决问题。若因预览宿主离线、`serverId` 异常、缺少工具或认证而无法执行，说明具体阻塞与未验收项并请求所需条件；不得声称端到端或 UI 验收通过。

## 验证底线

自动化覆盖固定快照、迟到异步结果、失败和清理路径；真实宿主端到端与视觉验收优先在已授权的独立预览宿主（`~/.paseo-zeonest-preview`，`127.0.0.1:6799`，`srv_ac1vmF5PAK5F`）完成并如实报告。日常宿主（`~/.paseo`）没有额外授权不得安装、更新、启用或重载插件；不修改任何 daemon 的 `pluginsEnabled`，不重启任何 daemon。
