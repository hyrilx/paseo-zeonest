import type { PluginServerContext } from "@getpaseo/plugin/server";
import { deletePrompt, listPrompts, savePrompt } from "../shared/contracts";
import { activeStore } from "./index";

export default function contribute(server: PluginServerContext) {
  let stopped = false;

  function access() {
    if (stopped) throw new Error("Prompt 管理器已停止");
    const store = activeStore();
    function guard() {
      if (stopped || activeStore() !== store) throw new Error("Prompt 管理器已停止");
    }
    return { store, guard };
  }

  server.handle(listPrompts, async () => {
    const { store, guard } = access();
    try {
      const prompts = await store.list(guard);
      return { prompts };
    } catch (error) {
      guard();
      throw new Error(error instanceof Error ? `无法读取 Prompt 列表：${error.message}` : "无法读取 Prompt 列表");
    }
  });

  server.handle(savePrompt, async (input) => {
    const { store, guard } = access();
    try {
      return await store.save(input, guard);
    } catch (error) {
      guard();
      throw new Error(error instanceof Error ? `无法保存 Prompt：${error.message}` : "无法保存 Prompt");
    }
  });

  server.handle(deletePrompt, async (input) => {
    const { store, guard } = access();
    try {
      return await store.remove(input, guard);
    } catch (error) {
      guard();
      throw new Error(error instanceof Error ? `无法删除 Prompt：${error.message}` : "无法删除 Prompt");
    }
  });

  return () => {
    stopped = true;
  };
}
