import type { PluginClientContext, PluginAgentPanelProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { FileActivityPanel, type Observe } from "./panel";
import { observeTimeline } from "./timeline";
import { WorkspaceFileActivityPanel, listWorkspaceAgents, type DirectoryLoader } from "./workspace";

export function registerFileActivity(client: PluginClientContext) {
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const observers = new Set<ReturnType<typeof observeTimeline>>();
  const requests = new Set<AbortController>();
  const removals: (() => unknown)[] = [];
  const observe: Observe = (agent, limit, source) => {
    if (stopped) return null;
    const observer = observeTimeline(agent, limit, source);
    const tracked = { retry: observer.retry, async stop() { try { await observer.stop(); } finally { observers.delete(tracked); } } };
    observers.add(tracked);
    return tracked;
  };
  const loadAgents: DirectoryLoader = async (paseo, workspaceId, signal) => {
    if (stopped) throw new Error("文件活动已停止。");
    const request = new AbortController();
    const abort = () => request.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    requests.add(request);
    try { return await listWorkspaceAgents(paseo, workspaceId, request.signal); }
    finally { signal.removeEventListener("abort", abort); requests.delete(request); }
  };
  const stop = () => stopping ??= (async () => {
    stopped = true;
    for (const request of requests) request.abort();
    requests.clear();
    await Promise.allSettled([...removals.reverse().map((remove) => Promise.resolve().then(remove)), ...[...observers].map((observer) => observer.stop())]);
    observers.clear();
  })();
  const AgentPanel = (props: PluginAgentPanelProps) => <FileActivityPanel {...props} observe={observe} />;
  const WorkspacePanel = (props: PluginWorkspacePanelProps) => <WorkspaceFileActivityPanel {...props} observe={observe} loadAgents={loadAgents} />;
  try {
    // Paseo's + menu lists only workspace-context panels, including in the explorer.
    removals.push(client.addWorkspacePanel({ id: "file-activity", title: "文件活动", icon: "Files", locations: ["explorer"], Component: WorkspacePanel }));
    removals.push(client.addAgentPanel({ id: "file-activity-agent", title: "文件活动", icon: "Files", locations: ["explorer"], Component: AgentPanel }));
    removals.push(client.addCommandCenterItem({ id: "file-activity-current", title: "查看当前会话文件活动", icon: "Files", context: "agent", keywords: ["文件", "活动", "diff", "files"],
      onSelect(context) { if (!stopped) context.openPanel("file-activity-agent", { location: "explorer" }); },
    }));
  } catch (error) { void stop(); throw error; }
  return stop;
}
