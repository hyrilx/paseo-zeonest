import type { PluginServerContext } from "@getpaseo/plugin/server";
import { notePresence, noteSummaries, readGlobalNote, readNote, saveGlobalNote, saveNote } from "../shared/contracts";
import { activeStore } from "./index";

export default function contribute(server: PluginServerContext) {
  let stopped = false;
  function access() {
    if (stopped) throw new Error("会话笔记已停止");
    const store = activeStore();
    function guard() {
      if (stopped || activeStore() !== store) throw new Error("会话笔记已停止");
    }
    return { store, guard };
  }
  server.handle(readNote, async ({ sessionId }) => {
    const { store, guard } = access();
    try { return await store.read(sessionId, guard); }
    catch { guard(); throw new Error("宿主无法读取会话笔记"); }
  });
  server.handle(saveNote, async (input) => {
    const { store, guard } = access();
    try { return await store.save(input, guard); }
    catch { guard(); throw new Error("宿主无法保存会话笔记"); }
  });
  server.handle(notePresence, async ({ sessionIds }) => {
    const { store, guard } = access();
    return { present: await store.presence(sessionIds, guard) };
  });
  server.handle(readGlobalNote, async () => {
    const { store, guard } = access();
    try { return await store.readGlobal(guard); }
    catch { guard(); throw new Error("宿主无法读取全局笔记"); }
  });
  server.handle(saveGlobalNote, async (input) => {
    const { store, guard } = access();
    try { return await store.saveGlobal(input, guard); }
    catch { guard(); throw new Error("宿主无法保存全局笔记"); }
  });
  server.handle(noteSummaries, async ({ sessionIds }) => {
    const { store, guard } = access();
    try { return await store.summaries(sessionIds, guard); }
    catch { guard(); throw new Error("宿主无法读取笔记列表"); }
  });
  return () => { stopped = true; };
}
