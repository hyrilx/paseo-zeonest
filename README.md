# Zeonest

Paseo 插件 ID：`zeonest`。这是个人维护的子功能聚合插件，所有功能随同一个插件分发。壳只负责功能目录、开关和配置入口，不提供业务框架。

## 当前状态

- 锁定 Paseo SDK **0.15.4**，客户端与 daemon 均需 0.15.4+。
- 初始不包含业务子功能；新增功能默认关闭。
- 功能列表展示名称、描述、版本、标签、作者及可选配置入口。
- 开关保存到所选宿主，**整体重新加载插件后生效**。客户端使用本次服务端启动快照，不提前应用待生效的开关。
- 子功能直接使用原生 Paseo context 和 cleanup，自主管理配置、数据与实现。业务关闭后，其配置入口仍可用。

## 开发

要求 Node.js 22+ 和 npm。

```bash
npm ci --ignore-scripts
npm run check
npm pack --dry-run --ignore-scripts
```

新增一个子功能：

```bash
npm run feature:new -- prompt-tools \
  --name "提示词工具" \
  --description "管理个人常用提示词" \
  --author "你的名字" \
  --runtime both --settings --tag productivity
```

脚手架只在 `features/prompt-tools/` 创建空贡献、说明及可选配置骨架，不改其他源码、不安装或开启插件。单端功能选择 `--runtime client` 或 `--runtime server`，无配置则省略 `--settings`。继续实现业务和功能测试后运行 `npm run check`。

```bash
npm run build          # 扫描、校验、原生类型检查、源级边界检查、双端打包及产物检查
npm run typecheck      # 源码、内存静态接线及测试类型
npm test               # 根 tests 与每个功能 tests 的递归测试发现
npm run bundle:check   # 检查已构建产物的原生入口图和 external
```

接线在构建时形成静态 imports，不维护需提交的生成清单。构建产物不提交。正常新增功能只修改该功能目录；新增第三方依赖等情况仍需维护根依赖与 lockfile。

## 在 Paseo 中使用

本仓库不会自动修改宿主开关或安装插件。确认信任并明确授权后，可以在目标宿主的 **Settings → Plugins** 安装本目录，或使用：

```bash
paseo plugin install /absolute/path/to/paseo-zeonest
paseo plugin ls zeonest
```

插件是**受信任、非沙箱代码**，服务端拥有 daemon 用户的文件、进程、凭据和网络权限。全局插件开关由你自行决定是否开启。

源码目录和 Git 安装通过 manifest 的显式准备命令执行锁定依赖安装及构建，不依赖被宿主跳过的 npm 生命周期脚本。预构建 npm 包只校验现有 bundle，不安装开发依赖或调用不存在的源码工具。详见[安装与打包流程](docs/development.md)。

打开 Zeonest 配置按钮，或在 Command Center 搜索「Zeonest：管理功能集」。保存开关后，在插件菜单「重新加载」，或：

```bash
paseo plugin reload zeonest
paseo plugin logs zeonest
```

源码修改后先重新构建，再整体重载插件；不需要重启 daemon。多宿主的开关与配置相互独立，同一宿主的授权客户端共享设置。改了安装 ID 时使用实际 ID。

## 源码导航

| 路径 | 用途 |
| --- | --- |
| `features/<id>/` | 一个功能的全部手写代码、六项元信息、README、测试与 fixtures |
| `shell/client/`、`shell/server/`、`shell/shared/` | 壳的手写实现与内部 helper |
| `index.client.tsx`、`index.server.ts` | 固定原生入口，只重导出本端 bundle |
| `client/bundle.js`、`server/bundle.js` | 自动构建的运行模块；目录内不放手写代码 |
| `tools/` | 统一扫描、脚手架、构建、边界、类型、测试及准备工具 |
| `tests/` | 壳、工具与整体集成测试，不放功能自有测试 |
| `.agents/skills/` | 维护壳和功能的项目内技能 |

进一步阅读：[架构](docs/architecture.md)、[子功能接入](docs/features.md)、[开发与验证](docs/development.md)、[代理开发约定](AGENTS.md)。
