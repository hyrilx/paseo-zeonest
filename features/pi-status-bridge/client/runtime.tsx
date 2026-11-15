import type { PluginButtonContentProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import { expandStatus, listStatuses } from "../shared/contracts";
import { errorMessage, pillLabel } from "../shared/text";
import { createStatusStore } from "./store";
import { StatusDetails } from "./details";

// One poll per installation, not per pill or per open popover. Updates preserve native registrations.
export function startStatusClient(client: PluginClientContext, intervalMs = 1000) {
  const source = createStatusStore();
  const pills = new Map<string, { registration: PluginButtonRegistration; Content: ComponentType<PluginButtonContentProps>; label: string; text: string; workspaceId: string }>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let nextId = 0;
  let reported = false;
  function reconcile() {
    const ids = new Set(source.get().map((entry) => entry.id));
    for (const [id, pill] of pills) if (!ids.has(id)) { pill.registration.remove(); pills.delete(id); }
    for (const entry of source.get()) {
      const label = entry.warning ? "Pi 状态桥接异常" : pillLabel(entry.key, entry.text);
      let existing = pills.get(entry.id);
      if (existing && existing.workspaceId !== entry.workspaceId) { existing.registration.remove(); pills.delete(entry.id); existing = undefined; }
      if (existing) {
        if (existing.label !== label || existing.text !== entry.text) {
          existing.registration.update({ label, title: entry.warning ? "Pi 状态桥接异常" : entry.key });
          existing.label = label; existing.text = entry.text;
        }
        continue;
      }
      const entryId = entry.id;
      const Content = (props: PluginButtonContentProps) => <StatusDetails {...props} source={source} entryId={entryId}
        expand={(status) => client.rpc(expandStatus, { agentId: status.agentId, key: status.key, command: status.command! })} />;
      const registration = client.addComposerPill({
        id: `pi-status-bridge-${++nextId}`, agentId: entry.agentId, workspaceId: entry.workspaceId,
        button: { title: entry.warning ? "Pi 状态桥接异常" : entry.key, label, icon: entry.warning ? "TriangleAlert" : "Activity", behavior: { kind: "popover", Content } },
      });
      pills.set(entry.id, { registration, Content, label, text: entry.text, workspaceId: entry.workspaceId });
    }
  }
  async function poll() {
    try {
      const snapshot = await Promise.race([
        client.rpc(listStatuses, {}),
        new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("读取 Pi 状态超时")), 10000); }),
      ]);
      if (stopped) return;
      source.apply(snapshot); reconcile(); reported = false;
    } catch (error) {
      if (stopped) return;
      const message = "无法读取 Pi 状态，旧状态已隐藏：" + errorMessage(error);
      source.fail(message); reconcile();
      if (!reported) { console.error("[pi-status-bridge]", message); reported = true; }
    } finally {
      clearTimeout(deadline); deadline = undefined;
      if (!stopped) timer = setTimeout(() => { void poll(); }, intervalMs);
    }
  }
  void poll();
  return () => {
    if (stopped) return;
    stopped = true; clearTimeout(timer); clearTimeout(deadline);
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear(); source.clear();
  };
}
