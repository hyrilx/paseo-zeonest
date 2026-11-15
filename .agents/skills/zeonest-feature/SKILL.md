---
name: zeonest-feature
description: 在 Zeonest 仓库新增、修改或移除静态集成的 Paseo 子功能；处理原生贡献、配置页、元信息和验证。
---

# Zeonest 子功能开发

先读仓库根目录的 `AGENTS.md`、`docs/architecture.md`、`docs/features.md` 和 `docs/development.md`。本 skill 所在目录向上三级为仓库根目录。

## 工作方式

1. 确定实际需求、运行端、是否需要配置及数据访问。缺少影响行为的决定时先询问。
2. 读取正在修改的子功能及已有测试，不把原生配置注册误放入可关闭业务入口。
3. 新功能使用：
   `npm run feature:new -- <id> --name "名称" --description "说明" --author "作者" [--runtime client|server|both] [--settings] [--tag 标签]`。
   脚手架只生成空接入，必须继续完成真实实现和行为测试。
4. 直接使用 `@getpaseo/plugin`、`/client`、`/client/ui`、`/server`，不依赖壳内部 helper。
5. 配置由功能自行定义及渲染。壳只列出元信息、控制业务入口是否执行、路由原生设置页。
6. 不做顶层业务副作用。cleanup 释放原生注册及其他资源，防止异步结果在关闭后重新生效。
7. 记录功能行为、配置生效方式、文件/网络/凭据访问及验证方法，更新功能版本。
8. `npm run features:sync`，再 `npm run check` 和 `npm pack --dry-run --ignore-scripts`。
9. 真实宿主验收按 development 文档执行；未获准则不安装、不启用，明确报告验证边界。

## 禁止扩大设计

不引入新的子功能基类、依赖注入、统一业务配置、共享容器上下文、动态加载、子功能包发布机制或通用事件总线。需要通用业务能力时先判断是否属于单个子功能内部，而非扩建壳。

修改现有功能时保持不相关功能及壳行为不变。删除功能后清理对应目录并同步静态导入，不直接修改生成文件。
