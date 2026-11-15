# 开发与验证

## 环境与依赖

使用 Node.js 22+、npm 和 Paseo 0.15.4+。执行 `npm ci` 安装开发依赖。

Paseo 在运行时提供 SDK、React、React Native、Zod 等宿主库，因此这些放在 `devDependencies`。目前没有额外运行时依赖或构建步骤。服务端功能引入额外运行库时由作者明确加入 `dependencies`，更新 lockfile，并按 Paseo 发布规范处理 Git preparation/npm shrinkwrap；不能假设用户机器有本仓库的开发依赖。

主 `tsconfig.json` 不包含 DOM 或 Node 全局类型，避免掩盖客户端误用。测试使用独立 tsconfig 开启 Node 类型。服务端需要 Node API 时显式导入 `node:*`，不要把 Node 全局类型加入客户端编译环境。

## 命令

| 命令 | 目的 |
| --- | --- |
| `npm run feature:new -- --help` | 查看脚手架参数 |
| `npm run features:sync` | 验证功能信息并写入三份静态清单 |
| `npm run features:check` | 检查清单是否过期，适合 CI |
| `npm run typecheck` | 运行时与测试 TypeScript 检查 |
| `npm test` | Node test runner + tsx 自动化测试 |
| `npm run bundle:check` | esbuild 构建两个入口，检查静态依赖图边界 |
| `npm run check` | 依次执行以上必要检查 |
| `npm pack --dry-run --ignore-scripts` | 审查整体发布内容，不发布 |

`bundle:check` 是辅助检查，不等价于 Paseo 的实际编译和真机运行。它不修改源码、不安装插件；后续采用新的原生宿主模块时需同步其允许列表，而不是偷偷绕过运行时限制。

## 自动化覆盖

壳测试关注开关默认值、未知 ID、待生效状态、固定启动快照、异步关闭、失败处理、清理顺序和宿主间状态独立。工具测试关注元信息校验、静态生成、客户端/服务端/双端脚手架、配置接入、重名拒绝和依赖边界。

新增子功能还需要自己的行为测试；壳测试不能证明任意子功能正确。

## 真实 Paseo 验收

仅在获准信任并安装插件后执行。不要为了测试擅自开启全局 `pluginsEnabled`，也不要重启 daemon。

1. 类型与测试通过后安装或重载实际插件 ID。
2. `paseo plugin ls zeonest` 应为 `running`，检查 `paseo plugin logs zeonest`。
3. 通过 Settings → Plugins → Zeonest 配置按钮或 Command Center 打开功能集。
4. 宽屏和 compact/mobile、明暗主题检查文字、布局、长描述、可访问性和空列表。
5. 启用/关闭一个测试功能，确认保存后显示待生效，重载前行为不变；重载后两端同步更新。
6. 重载前新连接一个客户端，确认使用服务端运行快照而非提前使用刚保存的开关。
7. 子功能关闭时仍能进入其配置页面；配置的行为遵循功能自己的说明。
8. 两客户端同时修改开关，确认过期 revision 不会覆盖新数据，可重新读取重试。
9. 检查断线、无效设置、初始化失败和清理失败的提示，不将未知状态显示为成功。

源码初始化和自动化检查不代表已完成这些人工/宿主集成验证。

## 发布与维护

`package.json` 暂设 `private: true`，防止个人项目误发布。整体版本与各功能展示版本分别维护。准备公开发布前由作者确认包名、作者、许可证、仓库、隐私说明及必要截图，再按[官方发布规范](https://paseo.sh/docs/plugins/publishing)操作。

发布白名单包含 manifest、OVERVIEW、两个入口以及全部 client/server/shared 实现和生成清单，确保子功能随壳整体分发。开发工具、tests、项目 skills 和 docs/ 文档保留在源码仓库，不进入运行包；npm 会自动带入根 README。

使用在线新 API 前对照本地 SDK 类型；在线 reference 已存在而 0.15.4 尚未发布的能力不能直接采用。升版时同步最低宿主版本并重新执行检查和真实宿主验收。
