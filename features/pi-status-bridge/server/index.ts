import type { PluginServerContext } from "@getpaseo/plugin/server";
import { activate } from "./activation";
import { createBridge } from "./bridge";
import { createPreload, observerEnvironment, providerNodeOptions } from "./preload";

export default function contribute(server: PluginServerContext, preload = createPreload()) {
  const bridge = createBridge();
  const busy = new Set<string>();
  let stopped = false;
  const removers: (() => void)[] = [];
  try {
    removers.push(server.addHook("agent.open.before", async ({ request }, context) => {
      if (stopped || context.signal.aborted || request.provider !== "pi" || request.purpose !== "interactive" || !request.workspaceId) return;
      try {
        // Preserve effective Node options: session hook env > provider env > daemon env.
        const fallback = request.env.NODE_OPTIONS === undefined
          ? providerNodeOptions((await context.paseo.config.get()).config.providers.pi?.env) ?? process.env.NODE_OPTIONS
          : undefined;
        const path = await preload.prepare();
        if (stopped || context.signal.aborted) return;
        const channel = await bridge.open(request.agentId, request.workspaceId);
        if (stopped || context.signal.aborted) { bridge.remove(request.agentId); return; }
        request.env = observerEnvironment(path, channel, request.env, fallback);
      } catch {
        bridge.remove(request.agentId);
        // Do not log config/env/token values. Failure is observational, never a launch veto.
        if (!stopped) console.error("[pi-status-bridge] Cannot inject status observer; Pi launch is unchanged. Check observer files and Node options.");
      }
    }));
    removers.push(server.addHook("agent.close.after", async ({ agent }) => { bridge.remove(agent.id); }));
    removers.push(server.addHook("agent.archive.after", async ({ agent }) => { bridge.remove(agent.id); }));
    removers.push(activate({ bridge, busy, alive: () => !stopped }));
  } catch (error) {
    stopped = true;
    for (const remove of removers.reverse()) remove();
    void bridge.close();
    throw error;
  }
  return async () => {
    stopped = true;
    try { for (const remove of removers.reverse()) remove(); }
    finally { await bridge.close(); busy.clear(); }
  };
}
