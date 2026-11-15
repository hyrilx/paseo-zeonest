---
name: zeonest-shell
description: 维护 Zeonest 的最小 Paseo 容器外壳、原生功能管理页、持久化开关、静态集成工具和启动快照。
---

# Zeonest 外壳维护

先读仓库根目录的 `AGENTS.md`、`docs/architecture.md`、`docs/development.md`。本 skill 所在目录向上三级为仓库根目录。

## 保持职责

外壳仅负责功能信息、host 级开关、整体重载时静态组合原生贡献，以及配置入口。子功能内部完全内聚，不增加 Zeonest 业务 SDK。

## 修改流程

1. 读取受影响源码和测试，确认修改的是壳职责而不是某项业务能力。
2. 配置界面使用 Paseo 原生 `addSettingsScreen` 与 Settings 组件，不复制宿主设置框架。
3. 区分保存的期望开关和本次服务端运行快照。新客户端必须跟随运行快照，不能提前启用待重载功能。
4. 整体重载后生效，不增加热启停或运行时动态注入。
5. 配置页和支撑配置的原生服务端注册始终可用；壳不得读取或重置子功能配置。
6. 异步启动在 cleanup 后不得复活。cleanup 倒序、幂等，单项失败不跳过后续清理。
7. 主动处理 loading、invalid、error、revision 冲突、待生效状态、空功能集和主题/compact。
8. 同步文档与测试，执行 `npm run check` 和打包清单检查。
9. 升级 SDK 时同步 manifest 最低版本并核对 daemon 与客户端。不凭在线文档假定未发布 API 已可用。

## 验证底线

自动化覆盖固定快照、迟到异步结果、失败和清理路径；Paseo 真机验证另行报告。没有授权不得安装/启用插件或修改全局开关，不重启 daemon。
