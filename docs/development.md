# 开发与验证

## 环境与依赖

要求 Node.js 22+、npm 和 Paseo 0.15.4+。执行 `npm ci --ignore-scripts` 安装锁定开发依赖。SDK 固定为 `@getpaseo/plugin@0.15.4`，不能用在线文档里的新 API 替代该版本类型。

宿主提供 SDK、React、React Native、TanStack Query 与 Zod，保持 external；用于类型检查的依赖放在 devDependencies。新增普通第三方运行库时明确加入根 dependencies，更新 package-lock.json。可静态打包的库打入相应 bundle，不保留悬空的 npm 导入；如果需要无法打包的原生模块、运行资源或独立安装步骤，应另行决定和验证，不暗中改变安装模型。

运行源码 tsconfig 包含 `shell/`、`features/`，排除功能 tests/fixtures，不加入 DOM 或 Node 全局类型。测试 tsconfig 覆盖根测试和递归功能测试，允许 Node 类型。服务端用 `node:*` 显式导入。统一类型检查还在内存中加入静态组合入口，检查各功能默认导出确实符合原生 contribution/settings screen 类型，而不是只让 esbuild 擦除类型。

## 命令

| 命令 | 目的 |
| --- | --- |
| `npm run feature:new -- --help` | 查看单目录功能脚手架参数 |
| `npm run hooks:install` | 每次克隆后启用本仓库的 pre-commit hook，不改全局配置 |
| `npm run docs:features` | 从 feature.json 更新 README 的功能目录生成区 |
| `npm run docs:features -- --check` | 仅检查 README 功能目录是否同步，过期时失败且不写入 |
| `npm run typecheck` | 运行源码、内存组合入口和测试的 TypeScript 检查 |
| `npm test` | 递归发现根 tests 和各功能 tests 下的测试，跳过 fixtures |
| `npm run build` | 元信息/入口/类型/源码边界校验，输出双端 bundle，检查原生入口图与 external，更新 README 功能目录 |
| `npm run bundle:check` | 仅检查已构建的产物 |
| `npm run check` | 全类型、所有测试及完整双端构建与边界检查 |
| `npm pack --dry-run --ignore-scripts` | 已构建后审查包内容，不发布 |

构建按功能 ID 稳定排序，校验目录/ID 匹配、六项元信息、SemVer、标签、入口冲突及至少一个业务入口。没有需人工维护的接线清单。`client/` 和 `server/` 是保留输出目录，构建时会删除重建；不在里面放手写文件。

### README 功能目录与提交 hook

`features/<id>/feature.json` 是六项展示元信息的唯一来源。生成器复用构建扫描与校验，在 README 的 `zeonest:features:start` / `zeonest:features:end` HTML 注释之间生成按 ID 排序的表格，包含名称、ID、描述、版本、标签和作者，并链接到功能 README；只替换生成区。生成结果随源码提交，供仓库页面直接展示，不是运行期接线清单。

每次克隆后运行 `npm run hooks:install`，将本仓库 `core.hooksPath` 设为 `.githooks`。命令会替换本仓库已有的 hooksPath；已有自定义 hook 时先合并。仓库不会通过 npm 生命周期脚本或安装插件自动配置 Git hook。

`pre-commit` 在暂存的功能元数据或 README 变更时运行：将 Git 暂存区检出到临时目录，使用同一生成器更新暂存的 README，并将生成区同步到工作区。未暂存的功能不进入表格；README 手写部分保持各自在暂存区和工作区中的内容，不执行会夹带其他改动的整文件 `git add README.md`。无效元信息或生成区标记会阻止提交，临时目录会清理。仅运行文档生成，不在提交时执行构建、安装依赖或加载插件。

也可以手动运行 `npm run docs:features` 后提交 README。`npm run build`（因此也包括 `npm run check`）会从工作区元数据更新目录，作为开发时的补充；安装时在本地生成不会更新远端仓库。跳过 hook 后用 `npm run docs:features -- --check` 检查是否漏提文档。

源码边界检查覆盖静态 import/export、type-only、import 类型查询、类型引用和传递依赖。运行源码不得导入测试/fixtures、仓库根开发工具、根模块、其他功能或壳内部实现；本端的业务 `tools/` 子目录是普通运行源码，不按目录名拒绝。shared 不引入任何端专用依赖。第三方声明与运行实现均检查，shared 的实现图按共享归属检查；拒绝非静态模块加载及运行源码软链接。SDK 私有/未知路径、未提供的宿主库子路径和 DOM 依赖也会失败。

本地 `.svg` 静态导入使用既有 esbuild 文本 loader。TypeScript 检查功能内的资源类型声明；源级检查仅对真实存在的本地 SVG 文件采用资源解析分支，仍检查词法/真实路径归属，不把非代码资源交给 TypeScript 模块解析器，也不泛化放行未知或缺失的导入。SVG 文本直接内联进所属 bundle，不引入额外资产构建或运行文件复制流程。

产物检查只允许原生入口及本端 `bundle.js` 两个模块出现在宿主的本地输入图中。所有本地实现均已打入 bundle，不留下 features/shell/tests 路径导入。宿主库不打包第二份；服务端 Node 内建模块可 external。

## 源码安装与预构建包

Paseo 0.15.4 支持 manifest `build` 的 argv 数组，准备命令与目录归属以固定版本源码为准：

- [manifest](https://github.com/getpaseo/paseo/blob/v0.15.4/packages/server/src/server/plugins/manifest.ts)
- [准备命令执行](https://github.com/getpaseo/paseo/blob/v0.15.4/packages/server/src/server/plugins/preparation-build.ts)
- [宿主编译器](https://github.com/getpaseo/paseo/blob/v0.15.4/packages/server/src/server/plugins/compiler-build.ts)
- [宿主模块](https://github.com/getpaseo/paseo/blob/v0.15.4/packages/server/src/server/plugins/plugin-sdk-specifiers.ts)

仓库的 manifest 声明：

```json
{ "build": [["node", "tools/prepare.mjs"]] }
```

同一个小入口处理两种明确的内容：

1. **本地/Git 源码目录**存在 `shell/`：执行 `npm ci --include=dev --ignore-scripts`，再 `npm run build`。因此 Git 不需要提交产物，也不依赖宿主获取源码时可能跳过的 npm 生命周期脚本。明确包含 dev 是因为 TypeScript/esbuild 是构建工具，不是运行依赖。准备过程需要 npm、锁定依赖的缓存或网络，并会重建该源码目录的 node_modules 和双端输出。源码编辑后先手动运行 build，再获准重载。
2. **预构建包**不含 `shell/`：只校验两个入口与两个 bundle 存在，不安装依赖、不调用缺失的源码工具。该入口自身仅使用 Node 内建模块，随运行包分发。未声明额外运行依赖的当前包不需要 node_modules。

`npm pack` 的 prepack 也使用这个已随包携带的准备入口：源码打包前构建；解包后的包只做完整性校验，不再运行不存在的开发脚本。使用 `--ignore-scripts` 做 dry-run 时必须先 build/check，不能把旧产物当成新版本。

运行包白名单为 manifest、README、OVERVIEW、两个固定入口、两个 bundle 及其原生类型声明，以及 `tools/prepare.mjs`。不包含 shell/features 手写源码、测试、fixtures、其余开发工具、skills 或 docs。不要仅复制不带准备工具的 manifest，也不要手动复制零散源码给宿主编译。新增需要运行期文件读取的资源时必须单独明确打包，不能把测试 fixtures 当运行资源。

## 自动化覆盖与验证记录

根 tests 只放壳、工具及整体集成测试；功能自有测试放在 `features/<id>/tests/`。统一测试命令递归发现，不需要修改测试清单。类型检查和测试发现都排除 fixtures。

覆盖默认关闭、未知 ID、待生效状态、固定服务端快照、客户端不提前应用已保存开关、两端异步关闭、清理顺序/幂等与失败、配置关闭后仍可用、加载/无效/冲突/主题 token 状态，以及空功能集、三类脚手架、元信息/入口错误、内存贡献类型、type-only/传递边界、共享依赖、端隔离、稳定构建和递归测试执行。

服务端集成测试在同步贡献返回时冻结 RPC 名称目录，按 Paseo 0.15.4 的行为通过该目录调用；覆盖真实功能的业务 RPC 在设置读取前已声明、关闭时拒绝业务、启用后可调用、启动失败及 cleanup 后失效。可选 `server/rpc.ts(x)` 同样检查原生类型、入口歧义及源码归属。

包集成测试在临时的干净源码目录执行 manifest 准备（真实 npm ci + build），再 pack/解包；核对精确文件白名单，并在没有 node_modules/源码的包里执行准备和原生入口图检查，缺失 bundle 必须失败。该测试使用本地 npm 缓存离线执行，先运行本项目的 npm ci 以填充缓存。

本次迁移在 macOS、Node 26.12.0 / npm 11.20.0 上执行自动化验证；没有实际安装、启用或重载插件。另直接下载并执行了 v0.15.4 的真实编译器源码，确认当前固定原生入口与双端 bundle 均可编译；这不等同于客户端真机渲染或所有平台验收。Node 22 最低版本与 Windows/Linux 未另行实机测试。

## 真实 Paseo 验收

仅在获准信任并安装插件后执行。不要擅自开启全局 pluginsEnabled，不重启 daemon。

1. 类型与测试通过，构建后安装或重载实际插件 ID，检查 running 与插件日志。
2. 通过 Settings → Plugins 的 Zeonest 配置按钮或 Command Center 打开功能集。
3. 宽屏、compact/mobile、明暗主题检查布局、长描述、可访问性、空列表。
4. 保存开关显示待生效，整体重载前不改变行为；重载后两端同步更新。
5. 重载前新连接客户端必须使用服务端本次运行快照，而非刚保存的开关。
6. 关闭功能后仍能访问其配置页面与配置服务，配置生效方式遵循功能说明。
7. 两客户端同时修改开关，过期 revision 不得覆盖新数据；可以重新读取重试。
8. 检查断线、无效设置、初始化/清理失败提示，不将未知状态显示为成功。

**本次未执行真实 Paseo 的宽屏/compact、明暗主题及出错状态验收。** 自动化状态/主题 token 测试不替代这些检查。

## 发布与维护

保持 `private: true`，此次不发布。插件整体版本和功能展示版本分别维护。未来公开发布前需由作者确认包名、作者、许可证、仓库、隐私说明与必要截图，并重新审查实际运行依赖、资源、宿主最低版本及完整包。

在线文档可能领先 SDK；引入新 API 前必须同步依赖、manifest 最低版本、自动化与真实宿主验证记录。
