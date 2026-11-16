---
name: zeonest-shell
description: 维护 Zeonest 的最小 Paseo 容器外壳、原生功能管理页、持久化开关、静态集成工具和启动快照。
---

# Zeonest 外壳维护

先读仓库根目录的 `AGENTS.md`、`docs/architecture.md`、`docs/development.md`。本 skill 所在目录向上三级为仓库根目录。

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

## 验证底线

自动化覆盖固定快照、迟到异步结果、失败和清理路径；Paseo 真机验证另行报告。没有授权不得安装/启用插件或修改全局开关，不重启 daemon。
