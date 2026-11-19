import type { PluginServerContext } from "@getpaseo/plugin/server";
import process from "node:process";
import { activate } from "./activation";
import { readPreferences } from "./configuration";
import { serviceManager } from "./managed-context";

export default function contribute(server: PluginServerContext) {
  const manager = serviceManager();
  const stopActivation = activate();
  let stopped = false;
  // Failure is visible in status and blocks Pi in the before-hook; never fall back to inline.
  let startup = Promise.resolve();
  let removeHook: () => void;
  try {
    removeHook = server.addHook("agent.open.before", async ({ request }, context) => {
      if (request.provider !== "pi" || request.purpose !== "interactive") return;
      if (stopped || context.signal.aborted) throw new Error("Billion Context 已停止，Pi 启动已取消");
      const effective = { ...process.env, ...request.env };
      if (effective.BILLION_CONTEXT_PLUGIN === "0" || effective.BILI_NATIVE_PI === "0" || effective.BILI_PROVIDER_REWRITES !== undefined) {
        throw new Error("Pi 环境显式禁用了 Billion Context 原生接入，请移除冲突设置后重试");
      }
      await startup;
      const settings = await readPreferences();
      const target = await manager.ensure(settings.biliCommand);
      if (stopped || context.signal.aborted) throw new Error("Billion Context 已停止，Pi 启动已取消");
      return { ...request, env: { ...request.env, BILI_PI_INLINE: "0", BILLION_CONTEXT_ATTACH: target.origin } };
    });
  } catch (error) { stopped = true; stopActivation(); throw error; }
  startup = manager.enable(readPreferences().then((settings) => settings.biliCommand), async () => (await readPreferences()).biliCommand).catch(() => {});
  return async () => {
    if (stopped) return;
    stopped = true; removeHook(); stopActivation();
    await startup; await manager.disable();
    // The independent service intentionally survives plugin reload/disable.
  };
}
