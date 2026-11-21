import type { PluginServerContext } from "@getpaseo/plugin/server";
import { NoteStore } from "./store";

let active: NoteStore | undefined;

export function activeStore() {
  if (!active) throw new Error("会话笔记未启用或已停止");
  return active;
}

export default function contribute(_server: PluginServerContext) {
  const store = new NoteStore();
  active = store;
  return () => { if (active === store) active = undefined; };
}
