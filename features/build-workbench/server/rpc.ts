import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import * as rpc from "../shared/contracts";
import { activeWorkbench } from "./index";
import { workspaceRoot } from "./paths";
import { ConfigurationFieldError } from "./options";

export async function resolveWorkspace(paseo: PluginHandlerContext["paseo"], id: string) {
  const snapshot = await paseo.workspaces.ref(id).refresh();
  if (!snapshot || snapshot.id !== id || snapshot.archivingAt || !snapshot.workspaceDirectory) throw new Error("当前宿主找不到可用的工作区");
  return { id, root: workspaceRoot(snapshot.workspaceDirectory) };
}

export default function contribute(server: PluginServerContext) {
  let stopped = false;
  async function access(paseo: Parameters<typeof resolveWorkspace>[0], id: string) {
    if (stopped) throw new Error("构建工作台已停止");
    const store = activeWorkbench();
    const workspace = await resolveWorkspace(paseo, id);
    if (stopped || activeWorkbench() !== store) throw new Error("构建工作台已停止");
    store.accept();
    return { store, workspace };
  }
  server.handle(rpc.discover, async ({ workspaceId }, { paseo }) => {
    const { store, workspace } = await access(paseo, workspaceId);
    return store.discover(workspace);
  });
  server.handle(rpc.tools, async ({ workspaceId, target }, { paseo }) => {
    const { store, workspace } = await access(paseo, workspaceId);
    return store.tools(workspace, target);
  });
  server.handle(rpc.selectTool, async ({ workspaceId, target, tool }, { paseo }) => {
    const { store, workspace } = await access(paseo, workspaceId);
    return store.selectTool(workspace, target, tool);
  });
  server.handle(rpc.verify, async ({ workspaceId, configuration }, { paseo }) => {
    const { store, workspace } = await access(paseo, workspaceId);
    return store.verify(workspace, configuration);
  });
  server.handle(rpc.preview, async ({ workspaceId, configuration }, { paseo }) => {
    const { store, workspace } = await access(paseo, workspaceId);
    try { return { kind: "ready" as const, ...store.preview(workspace, configuration) }; }
    catch (error) {
      if (error instanceof ConfigurationFieldError) return { kind: "invalid" as const, field: error.field, message: error.message };
      throw error;
    }
  });
  server.handle(rpc.save, async ({ workspaceId, configuration }, { paseo }) => {
    const { store, workspace } = await access(paseo, workspaceId);
    return store.save(workspace, configuration);
  });
  server.handle(rpc.remove, async ({ workspaceId, name }, { paseo }) => {
    const { store, workspace } = await access(paseo, workspaceId);
    return store.remove(workspace, name);
  });
  server.handle(rpc.start, async ({ workspaceId, configuration, fingerprint }, { paseo }) => {
    const { store, workspace } = await access(paseo, workspaceId);
    return store.start(workspace, configuration, fingerprint);
  });
  server.handle(rpc.retry, async ({ workspaceId, id, fingerprint, previewOnly }, { paseo }) => {
    const { store, workspace } = await access(paseo, workspaceId);
    return store.retry(workspace, id, fingerprint, previewOnly);
  });
  server.handle(rpc.stop, async ({ workspaceId, id }, { paseo }) => {
    const { store, workspace } = await access(paseo, workspaceId);
    return store.stop(workspace, id);
  });
  server.handle(rpc.list, async ({ workspaceId }, { paseo }) => {
    const { store, workspace } = await access(paseo, workspaceId);
    return store.list(workspace);
  });
  server.handle(rpc.detail, async ({ workspaceId, id, cursor }, { paseo }) => {
    const { store, workspace } = await access(paseo, workspaceId);
    return store.detail(workspace, id, cursor);
  });
  return () => { stopped = true; };
}
