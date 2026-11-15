import type { PluginServerContext } from "@getpaseo/plugin/server";
import { expandStatus, listStatuses } from "../shared/contracts";
import { activeBridge } from "./activation";
import { readPreferences } from "./configuration";
import { executeExpansion } from "./actions";

export default function contribute(server: PluginServerContext) {
  let closed = false;
  const current = () => {
    if (closed) throw new Error("Pi 状态桥接已停止");
    return activeBridge();
  };
  server.handle(listStatuses, async () => {
    const runtime = current();
    const preferences = await readPreferences();
    if (closed || !runtime.alive()) throw new Error("Pi 状态桥接已停止");
    return runtime.bridge.snapshot(preferences);
  });
  server.handle(expandStatus, async (input, context) => {
    const runtime = current();
    if (runtime.busy.has(input.agentId)) throw new Error("正在处理此会话的展开操作");
    runtime.busy.add(input.agentId);
    try {
      return await executeExpansion(input, context, runtime.bridge, await readPreferences(), () => !closed && runtime.alive());
    } finally { runtime.busy.delete(input.agentId); }
  });
  return () => { closed = true; };
}
