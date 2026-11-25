import type { PluginServerContext } from "@getpaseo/plugin/server";
import { PromptStore } from "./store";

let active: PromptStore | undefined;

export function activeStore(): PromptStore {
  if (!active) throw new Error("Prompt 管理器未启用或已停止");
  return active;
}

export default function contribute(_server: PluginServerContext) {
  const store = new PromptStore();
  active = store;
  return () => {
    if (active === store) active = undefined;
  };
}
