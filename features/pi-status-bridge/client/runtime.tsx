import type { PluginButtonContentProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import { expandStatus, listStatuses } from "../shared/contracts";
import { errorMessage, pillLabel } from "../shared/text";
import { createStatusStore } from "./store";
import { StatusDetails } from "./details";
import type { StatusScope } from "./details";

// One poll per installation, not per pill or per open popover. Updates preserve native registrations.
export function startStatusClient(client: PluginClientContext, intervalMs = 1000) {
  const source = createStatusStore();
  const pills = new Map<string, { registration: PluginButtonRegistration; Content: ComponentType<PluginButtonContentProps>; label: string; warning: boolean; workspaceId: string }>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let nextId = 0;
  let reported = false;
  function reconcile() {
    const groups = new Map<string, { scope: StatusScope; count: number; warnings: number; label: string; title: string }>();
    for (const entry of source.get()) {
      if (entry.pinned && !entry.warning) {
        groups.set(entry.id, { scope: { agentId: entry.agentId, workspaceId: entry.workspaceId, entryId: entry.id },
          count: 1, warnings: 0, label: pillLabel(entry.key, entry.text), title: entry.key });
        continue;
      }
      const id = JSON.stringify([entry.agentId]);
      let group = groups.get(id);
      if (!group) {
        group = { scope: { agentId: entry.agentId, workspaceId: entry.workspaceId }, count: 0, warnings: 0, label: "", title: "Pi 状态" };
        groups.set(id, group);
      }
      if (entry.warning) group.warnings++; else group.count++;
    }
    for (const group of groups.values()) if (!group.scope.entryId) {
      group.label = group.count ? `Pi 状态 · ${group.count}` : "Pi 状态";
      if (group.warnings) group.label += ` · ${group.warnings} 异常`;
      group.title = group.label;
    }
    for (const [id, pill] of pills) if (!groups.has(id)) { pill.registration.remove(); pills.delete(id); }
    for (const [id, group] of groups) {
      const { scope, label, title } = group;
      const warning = group.warnings > 0;
      const icon = warning ? "TriangleAlert" : "Activity";
      let existing = pills.get(id);
      if (existing && existing.workspaceId !== scope.workspaceId) { existing.registration.remove(); pills.delete(id); existing = undefined; }
      if (existing) {
        if (existing.label !== label || existing.warning !== warning) {
          existing.registration.update({ label, title, icon });
          existing.label = label; existing.warning = warning;
        }
        continue;
      }
      const Content = (props: PluginButtonContentProps) => <StatusDetails {...props} source={source} scope={scope}
        expand={(status) => client.rpc(expandStatus, { agentId: status.agentId, key: status.key, command: status.command! })} />;
      const registration = client.addComposerPill({
        id: `pi-status-bridge-${++nextId}`, agentId: scope.agentId, workspaceId: scope.workspaceId,
        button: { title, label, icon, behavior: { kind: "popover", Content } },
      });
      pills.set(id, { registration, Content, label, warning, workspaceId: scope.workspaceId });
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
