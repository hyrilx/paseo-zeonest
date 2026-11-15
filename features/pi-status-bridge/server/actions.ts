import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { Bridge } from "./bridge";
import type { Preferences } from "../shared/settings";

export async function executeExpansion(input: { agentId: string; key: string; command: string }, context: PluginHandlerContext,
  bridge: Bridge, preferences: Preferences, alive: () => boolean) {
  const status = bridge.snapshot(preferences).statuses.find((item) => item.agentId === input.agentId && item.key === input.key);
  if (!status || !status.command || status.command !== input.command) throw new Error("状态已移除、失效或命令映射已改变，请重新打开胶囊");
  const agent = context.paseo.agents.ref(input.agentId);
  await agent.refresh();
  function check() {
    const current = agent.current();
    if (!alive()) throw new Error("Pi 状态桥接已停止");
    if (!current || current.provider !== "pi" || current.workspaceId !== status!.workspaceId || current.archivedAt) throw new Error("此 Pi 会话已不可用");
    if (current.status !== "idle" || current.activeTurn || current.pendingPermissions.length) throw new Error("请先等待 Pi 当前任务或对话完成；不会中断或排队执行展开命令");
  }
  check();
  const commandName = input.command.slice(1).split(" ")[0]!;
  const result = await agent.commands();
  if (result.error) throw new Error("无法检查 Pi 命令：" + result.error);
  if (!result.commands.some((command) => command.name.replace(/^\//, "") === commandName && command.kind !== "skill")) {
    throw new Error("Pi 未加载此命令，不会发送：" + input.command);
  }
  // Refresh again after discovery; never intentionally interrupt a turn that began while checking.
  await agent.refresh();
  check();
  await agent.send(input.command);
  return { message: "已发送 " + input.command + "。插件通知和普通对话框会出现在 Paseo 聊天中；终端专用界面不支持。" };
}
