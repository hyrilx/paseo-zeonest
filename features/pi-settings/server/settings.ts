import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { commitChanges, discardChanges, inventoryModels, listWorkspaces, packageVersion, prepareChanges, preparePackage, prepareResource, probeMcp, readPreferences, readResource, readSnapshot, searchPackages, startSubscription, subscriptionAction, subscriptionCatalog, testModel } from "../shared/contracts";
import { PiSettingsService } from "./service";

export default function contributeSettings(server: PluginServerContext) {
  // One subprocess belongs to one host installation. Lazily create configuration-only resources.
  let instance: PiSettingsService | undefined;
  let closed = false;
  const service = (paseo: PluginHandlerContext["paseo"]) => {
    if (closed) throw new Error("Pi 设置服务已停止。");
    if (!instance) {
      instance = new PiSettingsService({ workspaceDirectory: async (id) => {
        const workspace = await paseo.workspaces.ref(id).refresh();
        if (!workspace || workspace.archivingAt) throw new Error("工作区不存在或已归档，请重新选择。");
        return workspace.workspaceDirectory ?? workspace.projectRootPath;
      } });
    }
    return instance;
  };
  server.handle(listWorkspaces, async (_, { paseo }) => {
    if (closed) throw new Error("Pi 设置服务已停止。");
    const entries = new Map<string, { id: string; name: string; directory: string }>();
    let cursor: string | undefined;
    const visited = new Set<string>();
    do {
      const result = await paseo.workspaces.list({ page: { limit: 200, cursor } });
      for (const entry of result.entries) if (!entry.archivingAt) entries.set(entry.id, { id: entry.id, name: entry.title ?? entry.name, directory: entry.workspaceDirectory ?? entry.projectRootPath });
      cursor = result.pageInfo.hasMore ? result.pageInfo.nextCursor ?? undefined : undefined;
      if (cursor && (visited.has(cursor) || entries.size > 10_000)) throw new Error("工作区分页无效或数量超过 10000，请缩小宿主工作区范围。");
      if (cursor) visited.add(cursor);
    } while (cursor);
    return [...entries.values()];
  });
  server.handle(readSnapshot, (input, { paseo }) => service(paseo).snapshot(input));
  server.handle(readPreferences, (_, { paseo }) => service(paseo).readPreferences());
  server.handle(readResource, (input, { paseo }) => service(paseo).readResource(input, input.id));
  server.handle(inventoryModels, (input, { paseo }) => service(paseo).listModels(input));
  server.handle(subscriptionCatalog, (input, { paseo }) => service(paseo).listSubscriptions(input));
  server.handle(startSubscription, (input, { paseo }) => service(paseo).startSubscription(input));
  server.handle(subscriptionAction, (input, { paseo }) => service(paseo).subscriptionAction(input));
  server.handle(testModel, (input, { paseo }) => service(paseo).testModel(input));
  server.handle(probeMcp, (input, { paseo }) => service(paseo).testMcp(input));
  server.handle(searchPackages, (input, { paseo }) => service(paseo).searchPackages(input.query));
  server.handle(packageVersion, (input, { paseo }) => service(paseo).packageVersion(input, input.source));
  server.handle(prepareChanges, (input, { paseo }) => service(paseo).prepare(input, input.edits));
  server.handle(prepareResource, (input, { paseo }) => service(paseo).prepareResource(input, input.id, input.text, input.revision));
  server.handle(preparePackage, (input, { paseo }) => service(paseo).preparePackage(input, input));
  server.handle(commitChanges, (input, { paseo }) => service(paseo).commit(input.token, input.confirmed));
  server.handle(discardChanges, (input, { paseo }) => ({ discarded: service(paseo).discard(input.token) }));
  return () => { closed = true; instance?.dispose(); instance = undefined; };
}
