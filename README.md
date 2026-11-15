# Zeonest

Paseo 插件 ID：`zeonest`。这是一个供个人维护的子功能聚合容器，所有功能随同一个插件发布。壳本身不增加业务能力，只负责功能目录、开关和配置入口。

## 当前状态

- 基于 Paseo **0.15.4** 的原生插件、设置页面和持久化设置 API。
- 初始不包含业务子功能；新增功能默认关闭。
- 功能列表展示名称、描述、版本、标签、作者及可选配置入口。
- 开关保存到所选宿主，**整体重新加载插件后生效**，而非运行时热插拔。
- 子功能直接使用 Paseo SDK，自行管理实现、配置、数据和资源清理，没有 Zeonest 业务 SDK 或动态注入协议。

## 开发

要求 Node.js 22+、npm 和 Paseo 0.15.4+。客户端与 daemon 均需满足版本要求。

```bash
npm ci
npm run check
```

新增一个子功能：

```bash
npm run feature:new -- prompt-tools \
  --name "提示词工具" \
  --description "管理个人常用提示词" \
  --author "你的名字" \
  --runtime both --settings --tag productivity
```

该命令生成待实现的空子功能及可选原生配置页面，并更新静态导入清单；不会安装插件、开启功能或改动 daemon。仅需单端能力时使用 `--runtime client` 或 `--runtime server`，没有配置时省略 `--settings`。

```bash
npm run features:sync   # 新增、删除入口或修改功能信息后更新清单
npm run features:check  # 只校验，不写文件
npm run check           # 清单、类型、测试、双端 bundle 边界
npm pack --dry-run --ignore-scripts
```

## 在 Paseo 中使用

本仓库初始化不会修改宿主的插件开关，也不会自动安装。确认信任本项目后，在目标宿主的 **Settings → Plugins** 安装本目录：

```bash
paseo plugin install /absolute/path/to/paseo-zeonest
paseo plugin ls zeonest
```

插件是**受信任、非沙箱代码**，服务端具有 daemon 用户的文件、进程、凭据和网络权限。宿主的全局插件开关需要你自行明确授权开启。

打开 Zeonest 的配置按钮，或在 Command Center 搜索「Zeonest：管理功能集」。保存开关后，使用插件菜单的「重新加载」，或：

```bash
paseo plugin reload zeonest
paseo plugin logs zeonest
```

代码更新同样需要重新加载插件，不需要重启 daemon。多宿主安装的开关和配置相互独立；同一宿主的授权客户端共享设置。通过 `--id` 改了安装 ID 时，CLI 命令也使用实际安装 ID。

## 源码导航

| 路径 | 用途 |
| --- | --- |
| `index.client.tsx` / `index.server.ts` | Paseo 原生入口 |
| `client/` / `server/` / `shared/` | 原生运行时边界 |
| `features/<id>/feature.json` | 六项展示信息 |
| `client/features/<id>/` 等 | 子功能自有实现 |
| `*.generated.ts` | 开发期生成并提交的静态集成清单 |
| `tools/` | 新增功能、同步清单和 bundle 检查 |
| `tests/` | 壳和开发工具的自动化测试 |
| `.agents/skills/` | 维护壳和新增子功能的项目内技能 |

进一步阅读：[架构](docs/architecture.md)、[子功能接入](docs/features.md)、[开发与验证](docs/development.md)、[代理开发约定](AGENTS.md)。
