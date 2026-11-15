# 子功能接入

## 最小接入信息

在 `features/<id>/feature.json` 提供六项展示信息：

```json
{
  "id": "prompt-tools",
  "name": "提示词工具",
  "description": "管理个人常用提示词",
  "version": "0.1.0",
  "tags": ["productivity"],
  "author": "你的名字"
}
```

ID 使用小写 kebab-case，和目录名一致，不能使用保留的 `zeonest`。版本使用 SemVer，表示子功能版本，与插件整体版本无关；它是展示信息，不参与装载或依赖解析。名称、描述、作者非空，标签可以为空数组。

## 接入文件

工具识别以下可选文件；每个位置选择 `.ts` 或 `.tsx`，不要同时存在：

| 文件 | 默认导出 | 执行时机 |
| --- | --- | --- |
| `features/<id>/client/index.ts(x)` | 原生 `PluginClientContribution` | 功能启用后的客户端启动 |
| `features/<id>/server/index.ts(x)` | 原生 `PluginServerContribution` | 功能启用后的服务端启动 |
| `features/<id>/client/settings.ts(x)` | 原生 `PluginSettingsScreenContribution` | 无论开关，始终注册配置页 |
| `features/<id>/server/settings.ts(x)` | 原生 `PluginServerContribution` | 无论开关，始终注册配置所需服务 |

至少有一个 `index`。无 UI 的服务端功能不需要客户端入口；纯客户端功能不需要服务端业务入口。设置文件均非必需。

功能的全部手写文件内聚在一个目录中，无需求的目录/文件不必创建：

```text
features/prompt-tools/
  feature.json           # 唯一六项展示元信息源
  README.md              # 行为、配置、数据访问与验收
  client/index.ts        # 可关闭的客户端业务贡献
  client/settings.tsx    # 可选，始终可用的原生配置页
  server/index.ts        # 可关闭的服务端业务贡献
  server/settings.ts     # 可选，始终运行的配置注册
  shared/                # 可选，两端可用的普通值、schema、契约和类型
  tests/                 # 功能自有测试，递归发现 *.test.ts(x)/js 等
    fixtures/            # 测试数据，不进入运行 bundle/包
```

子目录中的业务代码、数据结构和实现方式自主，不需要独立 package.json、构建或安装树。用普通相对路径，例如 `client/index.ts` 导入 `../shared/contracts`。本端可以导入本端/shared；shared 不能反向引入某一端。构建检查类型依赖和传递依赖，拒绝跨功能实现依赖、功能依赖壳内部 helper、运行代码依赖测试/fixtures 或仓库根 `tools/`。本端的业务子目录可以叫 `tools/`，例如 `server/tools/helper.ts`，其内容仍遵守同样的源码归属规则；不是按这个目录名保留给仓库开发工具。根 `client/` 和 `server/` 是可删除的构建输出，不在其中编写功能或壳代码。

同功能、本端或 shared 内的静态 `.svg` 可以通过普通相对路径导入，构建时作为文本内联，无需把 SVG 文件额外加入运行包白名单。为 TypeScript 提供声明，例如在该功能内的 `assets.d.ts` 写入：

```ts
declare module "*.svg" {
  const value: string;
  export default value;
}
```

SVG 必须是真实存在的文件，类型声明不代表可以导入缺失资源。资源导入与代码一样检查词法路径和真实路径，不能跨端、跨功能、依赖壳内部或测试/仓库工具；也不通过软链接绕过。这里只支持已有的 SVG 文本加载方式，不放行任意未解析的扩展名。

客户端入口示例：

```ts
import type { PluginClientContext } from "@getpaseo/plugin/client";

export default function contribute(client: PluginClientContext) {
  const remove = client.addCommandCenterItem({
    id: "prompt-tools-open",
    title: "提示词工具",
    icon: "Text",
    context: "global",
    onSelect() {
      client.openSettings("prompt-tools-settings");
    },
  });
  return remove;
}
```

服务端入口、RPC、hooks、provider 和其他能力全部使用 Paseo 原生 API。贡献函数同步返回 cleanup，cleanup 可以异步；异步初始化应在函数内部管理，并在关闭后阻止迟到结果产生副作用。

## 配置页面

客户端 `settings.tsx` 导出原生描述符：

```tsx
import type { PluginSettingsScreenContribution } from "@getpaseo/plugin/client";
import { PromptToolsSettings } from "./ui/prompt-tools-settings";

export default {
  id: "prompt-tools-settings",
  title: "提示词工具",
  icon: "Settings",
  Component: PromptToolsSettings,
} satisfies PluginSettingsScreenContribution;
```

页面自己使用 `useSettings`、`useRpc` 或其他原生能力。壳不会向它传递额外的配置对象或方法，只让 Paseo 按原生 `PluginSurfaceProps` 渲染页面。

若使用原生 `defineSettings`，将定义放在 `features/<id>/shared/`，在 `features/<id>/server/settings.ts` 调用 `server.registerSettings`。这样业务关闭时仍可配置。支撑配置的 RPC 也可以在该原生服务端贡献中注册。

原生设置文档必须能从 `{}` 解析出默认值；使用版本化 schema，并由该功能负责迁移、加载、错误和并发写入状态。壳不参与这些工作。

## 新增与更新

1. 运行 `npm run feature:new -- --help`，按实际需求选择单端/双端与配置页面。
2. 在生成的空贡献中实现完整功能；脚手架不是业务功能。
3. 在 `features/<id>/README.md` 说明行为、配置生效方式、数据访问和验证方法。
4. 在 `features/<id>/tests/` 增加功能自身测试与 fixtures，不仅依赖壳测试。统一命令递归发现测试，无需维护清单。
5. 运行 `npm run check`、`npm pack --dry-run --ignore-scripts`。
6. 获准安装后在真实 Paseo 验证，保持新增功能默认关闭。

修改展示信息、增加/删除入口或删除整个功能后，统一构建会自动重新扫描。除新增第三方依赖等合理例外，正常新增功能只修改 `features/<id>/`，不修改壳、原生入口、根测试或构建清单。提交手写代码，不提交 bundle 或临时接线。删除功能只需移除该功能目录后重新验证。

## Paseo 原生注意事项

- 同一插件内注册 ID、RPC 名称、设置 ID 应唯一。建议加功能 ID 前缀；这只是避免原生冲突，不是壳的命名空间 API。
- 壳保留配置页 `zeonest-features`、命令 `zeonest-settings`、设置 `zeonest-shell`、RPC `zeonest.shell.runtime`。
- 每个功能内不跨 `client/` 和 `server/` 导入，`shared/` 不引入 Node、React 或端专用 API/类型。也不通过 type-only、软链接或第三方模块转一道来绕过边界。
- 第三方库需要显式维护根依赖与 lockfile；可打包的库随本端 bundle 分发。宿主库只使用 0.15.4 支持的模块路径，不导入 `zod/v4` 等未提供的宿主子路径，也不打入第二份宿主运行库。
- 不在模块顶层产生业务副作用。所有子功能会静态导入，关闭只是不执行其业务贡献。
- 关闭后不应继续注册 hooks、观察 agent、启动进程或发送业务请求；把这些行为放在业务入口，而非始终运行的配置入口。
- 释放自己的计时器、watcher、订阅、句柄、进程和原生注册。不要假设另一个子功能一定启用。
- React Native UI 使用主题 token，适配 compact；客户端不能使用 Node/DOM 或未打包且未由宿主提供的运行时模块。
- 涉及文件写入、外部网络、凭据或 agent 自动操作时，由功能明确说明并采取适当授权。

参考：[Paseo 插件文档](https://paseo.sh/docs/plugins)、[原生 API](https://paseo.sh/docs/plugins/reference)。在线文档可能领先已发布版本，始终以仓库锁定 SDK 的类型和实际宿主能力校验。
