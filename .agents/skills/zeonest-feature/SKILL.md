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
   脚手架只在 `features/<id>/` 生成空接入，不改壳、根入口或其他目录。必须继续完成真实实现和 `features/<id>/tests/` 的行为测试；fixtures 也放在功能 tests 内。
4. 所有手写实现内聚于功能目录的 client/server/shared，使用普通相对路径。直接使用固定 0.15.4 的原生 SDK，不依赖壳内部 helper 或其他功能实现；包括类型和传递依赖都必须遵守本端/shared 边界。本端业务可以使用 tools 子目录；禁止的是测试/fixtures 与仓库根开发工具依赖。静态 SVG 使用本功能的类型声明和既有文本打包，资源同样受源码归属检查。不要创建功能独立 package.json/构建/安装树。
5. 配置由功能自行定义及渲染。壳只列出元信息、控制业务入口是否执行、路由原生设置页。
6. 不做顶层业务副作用。cleanup 释放原生注册及其他资源，防止异步结果在关闭后重新生效。
7. 记录功能行为、配置生效方式、文件/网络/凭据访问及验证方法，更新功能版本。
8. 运行 `npm run check` 和 `npm pack --dry-run --ignore-scripts`。构建自动扫描功能并形成内存静态接线，递归发现功能测试；不维护根列表，不提交 bundle/接线产物。根 client/server 是可删除输出，不放手写代码。新增普通第三方依赖才需维护根依赖和 lockfile；宿主库保持 external。
9. 真实宿主验收按 development 文档执行；未获准则不安装、不启用，明确报告验证边界。

## 禁止扩大设计

不引入新的子功能基类、依赖注入、统一业务配置、共享容器上下文、动态加载、子功能包发布机制或通用事件总线。需要通用业务能力时先判断是否属于单个子功能内部，而非扩建壳。

修改现有功能时保持不相关功能及壳行为不变。删除功能只移除该功能目录，再运行统一验证。源码安装通过 manifest 显式准备，不能仅依赖宿主会跳过的 npm 生命周期脚本。
