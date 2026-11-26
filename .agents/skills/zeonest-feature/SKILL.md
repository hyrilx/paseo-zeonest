---
name: zeonest-feature
description: 在 Zeonest 仓库新增、修改或移除静态集成的 Paseo 子功能；处理原生贡献、配置页、元信息和验证。必须使用 zeonest-git 管理任务分支、worktree、逐轮提交、远端同步及合并后清理。已获授权在独立预览宿主通过 paseo plugin update zeonest --ref 与浏览器完成端到端测试和视觉验收，涉及 UI 时还须结合前端技能。
---

# Zeonest 子功能开发

先读仓库根目录的 `AGENTS.md`、`docs/architecture.md`、`docs/features.md` 和 `docs/development.md`。本 skill 所在目录向上三级为仓库根目录。

开始修改前，必须加载并遵循 [Git 协作技能](../zeonest-git/SKILL.md)，先确定任务分支和独立 worktree；每轮有改动的对话独立提交，获授权合入主干时将整个任务 squash 为一个提交，默认推送 main 并同步开发分支；合入过程复用已有独立 worktree 与有效验证结果，按实际改动补充检查。后续开发、验证和提交均在自己的 worktree 中执行；主干合并推送、开发分支处理完成后，必须核对并移除本任务创建的 worktree。

## 工作方式

1. 确定实际需求、运行端、是否需要配置及数据访问。缺少影响行为的决定时先询问。
2. 读取正在修改的子功能及已有测试，不把原生配置注册误放入可关闭业务入口。
3. 新功能使用：
   `npm run feature:new -- <id> --name "名称" --description "说明" [--author "作者"] [--runtime client|server|both] [--settings] [--tag 标签]`。
   作者优先取仓库根目录的 `.author`；文件不存在或为空时须传 `--author`。
   脚手架只在 `features/<id>/` 生成空接入，不改壳、根入口或其他目录。必须继续完成真实实现和 `features/<id>/tests/` 的行为测试；fixtures 也放在功能 tests 内。
4. 所有手写实现内聚于功能目录的 client/server/shared，使用普通相对路径。直接使用固定 0.15.4 的原生 SDK，不依赖壳内部 helper 或其他功能实现；包括类型和传递依赖都必须遵守本端/shared 边界。本端业务可以使用 tools 子目录；禁止的是测试/fixtures 与仓库根开发工具依赖。静态 SVG 使用本功能的类型声明和既有文本打包，资源同样受源码归属检查。不要创建功能独立 package.json/构建/安装树。
5. 配置由功能自行定义及渲染。壳只列出元信息、控制业务入口是否执行、路由原生设置页。
6. 不做顶层业务副作用。业务 RPC 在可选 `server/rpc.ts(x)` 的原生贡献内同步 `handle`，不能等异步开关读取后的 `server/index.ts(x)` 再注册；0.15.4 的宿主 RPC 名称目录不会随迟到注册更新。该入口只声明处理函数，功能内部先检查启用状态，再读取设置或执行 IO；关闭、启动失败、cleanup 后均拒绝。业务 hooks/监听仍放在 `index`，cleanup 释放资源并阻止迟到结果。
7. 记录功能行为、配置生效方式、文件/网络/凭据访问及验证方法，更新功能版本。
8. 运行 `npm run check` 和 `npm pack --dry-run --ignore-scripts`。构建自动扫描功能并形成内存静态接线，递归发现功能测试；不维护根列表，不提交 bundle/接线产物。根 client/server 是可删除输出，不放手写代码。新增普通第三方依赖才需维护根依赖和 lockfile；宿主库保持 external。
9. 真实宿主端到端测试与视觉验收按下文独立预览宿主方案执行；日常宿主（`~/.paseo`）未获额外授权不得安装、启用、更新或重载插件，明确报告验证边界。

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
4. **在浏览器内完成端到端验收**：在浏览器打开 `http://127.0.0.1:6799/settings/hosts/srv_ac1vmF5PAK5F/plugins/zeonest`，确认新功能默认关闭后，可在该预览宿主内开启开关并点击 Zeonest「重新加载」（或执行 `paseo plugin reload zeonest --home "$preview"`，仅作用于预览宿主），按功能需求验证 RPC、设置持久化、启停与重载、错误恢复和主要交互。
5. **回退与数据隔离**：需要对照基线或回退版本时，对预览宿主再次执行 `paseo plugin update zeonest --ref <目标SHA> --home "$preview"` 即可。预览宿主只隔离 Paseo 会话与插件设置，**不隔离同一操作系统用户的文件系统**；验收会读写文件、Pi 配置或外部状态的功能时，必须使用独立临时目录、测试会话与样例数据，不得改动用户日常数据。
6. **严格区分日常宿主**：日常宿主（`~/.paseo`）始终不在本许可范围内；未经用户明确授权，绝不对其安装、更新、启停或重载插件，不修改其 `pluginsEnabled`，不重启任何 daemon。

## UI 开发与验收（涉及界面时必做）

1. 新增或修改可见界面、布局、样式或交互时，实现前必须加载并使用相关前端 skill。布局与视觉设计加载 `design-taste-frontend`，动画等专项按实际技术栈补充对应技能；在交付说明中列出使用的技能。
2. 前端技能用于指导视觉层级、间距、可访问性和交互反馈。实现遵守本仓库的 React Native、Paseo 原生组件、主题 token、compact 与 SDK 边界，不照搬网站模板、品牌配色或 DOM/CSS 示例，不为套用技能引入新依赖。本仓库的浏览器辅助开发与验收必须使用浏览器自动化工具（`agent_browser` 或当前环境提供的原生浏览器工具），通用技能的检查脚本不能替代它。
3. 开发开始时可先在独立预览宿主（`http://127.0.0.1:6799/`）查看现状并截图。完成首轮实现与本地提交后，按上文流程将预览宿主更新到当前 `HEAD` SHA，在浏览器内检查实际渲染与交互；每轮视觉修正后重新提交、更新预览宿主并复验。必须打开截图检查像素结果，不能只读源码、DOM 或可访问性快照。仅当预览宿主确实不可用时，才退回渲染真实组件的本地预览辅助开发，并记录 mock 范围与真实 Paseo 验收阻塞项。
4. 使用原生浏览器工具（如 `agent_browser` 或宿主提供的 `browser_*` 工具，不经 bash 调用）：打开页面后先获取交互快照（如 `snapshot -i`），按当前 refs 操作，导航或 DOM 变化后重新快照；截图后核对产物验证结果并读取图像。截图存临时目录，不提交个人运行数据。
5. 完成前在独立预览宿主的浏览器中验收宽屏/compact 与明/暗主题组合，并覆盖本次 UI 涉及的 loading、空数据、错误、长文本、滚动、键盘焦点与主要操作反馈。发现溢出、遮挡、对比不足、触控目标过小或状态反馈不清时，修正后重新提交、更新预览宿主、截图与复验。类型、单元测试和构建通过不能代替视觉验收。
6. 交付时记录预览宿主版本、已更新的提交 SHA、预览访问地址、视口尺寸、主题、已验证的状态与操作、截图路径及未解决问题。若因预览宿主离线、`serverId` 异常、缺少工具或认证而无法执行，说明具体阻塞与未验收项并请求所需条件；不得声称端到端或 UI 验收通过。

## 禁止扩大设计

不引入新的子功能基类、依赖注入、统一业务配置、共享容器上下文、动态加载、子功能包发布机制或通用事件总线。需要通用业务能力时先判断是否属于单个子功能内部，而非扩建壳。

修改现有功能时保持不相关功能及壳行为不变。删除功能只移除该功能目录，再运行统一验证。源码安装通过 manifest 显式准备，不能仅依赖宿主会跳过的 npm 生命周期脚本。
