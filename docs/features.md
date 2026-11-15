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
| `client/features/<id>/index.ts(x)` | 原生 `PluginClientContribution` | 功能启用后的客户端启动 |
| `server/features/<id>/index.ts(x)` | 原生 `PluginServerContribution` | 功能启用后的服务端启动 |
| `client/features/<id>/settings.ts(x)` | 原生 `PluginSettingsScreenContribution` | 无论开关，始终注册配置页 |
| `server/features/<id>/settings.ts(x)` | 原生 `PluginServerContribution` | 无论开关，始终注册配置所需服务 |

至少有一个 `index`。无 UI 的服务端功能不需要客户端入口；纯客户端功能不需要服务端业务入口。设置文件均非必需。

只有以上静态接线位置有约定，子目录中的业务代码、数据结构和实现方式不受壳约束。共享代码通常放在 `shared/features/<id>/`。也可以在接入文件中导入你自行组织的模块，只要遵守 Paseo 运行时边界。

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

若使用原生 `defineSettings`，将定义放在 `shared/features/<id>/`，在 `server/features/<id>/settings.ts` 调用 `server.registerSettings`。这样业务关闭时仍可配置。支撑配置的 RPC 也可以在该原生服务端贡献中注册。

原生设置文档必须能从 `{}` 解析出默认值；使用版本化 schema，并由该功能负责迁移、加载、错误和并发写入状态。壳不参与这些工作。

## 新增与更新

1. 运行 `npm run feature:new -- --help`，按实际需求选择单端/双端与配置页面。
2. 在生成的空贡献中实现完整功能；脚手架不是业务功能。
3. 在 `features/<id>/README.md` 说明行为、配置生效方式、数据访问和验证方法。
4. 增加功能自身的测试，不仅依赖壳测试。
5. 运行 `npm run features:sync`、`npm run check`。
6. 获准安装后在真实 Paseo 验证，保持新增功能默认关闭。

修改展示信息、增加/删除接入文件或移除功能时都要重新同步。生成文件应提交到版本控制，运行时不执行生成器。删除功能需移除其展示信息和相应运行时目录，再同步。

## Paseo 原生注意事项

- 同一插件内注册 ID、RPC 名称、设置 ID 应唯一。建议加功能 ID 前缀；这只是避免原生冲突，不是壳的命名空间 API。
- 壳保留配置页 `zeonest-features`、命令 `zeonest-settings`、设置 `zeonest-shell`、RPC `zeonest.shell.runtime`。
- 不跨 `client/` 和 `server/` 导入，根目录不添加其他代码模块；`shared/` 不引入端专用 API。
- 不在模块顶层产生业务副作用。所有子功能会静态导入，关闭只是不执行其业务贡献。
- 关闭后不应继续注册 hooks、观察 agent、启动进程或发送业务请求；把这些行为放在业务入口，而非始终运行的配置入口。
- 释放自己的计时器、watcher、订阅、句柄、进程和原生注册。不要假设另一个子功能一定启用。
- React Native UI 使用主题 token，适配 compact；客户端不能使用任意 Node/DOM/未由宿主提供的运行时模块。
- 涉及文件写入、外部网络、凭据或 agent 自动操作时，由功能明确说明并采取适当授权。

参考：[Paseo 插件文档](https://paseo.sh/docs/plugins)、[原生 API](https://paseo.sh/docs/plugins/reference)。在线文档可能领先已发布版本，始终以仓库锁定 SDK 的类型和实际宿主能力校验。
