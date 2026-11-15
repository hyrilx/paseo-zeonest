import assert from "node:assert/strict";
import test from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contributeSettings from "../server/settings";
import { listWorkspaces, readSnapshot } from "../shared/contracts";

test("configuration RPCs register while business is disabled and teardown blocks late initialization", async () => {
  const handlers = new Map<string, (input: any, context: any) => any>();
  const cleanup = contributeSettings({ handle: (contract: { name: string }, handler: (input: any, context: any) => any) => handlers.set(contract.name, handler) } as unknown as PluginServerContext);
  assert.equal(handlers.size, 8);
  cleanup(); cleanup();
  await assert.rejects(async () => handlers.get(readSnapshot.name)!({}, { paseo: {} }), /服务已停止/);
});

test("workspace selector follows native pagination and does not include archived entries", async () => {
  const handlers = new Map<string, (input: any, context: any) => any>();
  const cleanup = contributeSettings({ handle: (contract: { name: string }, handler: (input: any, context: any) => any) => handlers.set(contract.name, handler) } as unknown as PluginServerContext);
  const cursors: (string | undefined)[] = [];
  const entry = (id: string, archivingAt: string | null = null) => ({ id, name: id, projectRootPath: `/root/${id}`, workspaceDirectory: `/worktrees/${id}`, archivingAt });
  const context = { paseo: { workspaces: { list: async (options: { page: { cursor?: string } }) => {
    cursors.push(options.page.cursor);
    return options.page.cursor ? { entries: [entry("two"), entry("archived", "now")], pageInfo: { hasMore: false, nextCursor: null } } : { entries: [entry("one")], pageInfo: { hasMore: true, nextCursor: "next" } };
  } } } };
  assert.deepEqual(await handlers.get(listWorkspaces.name)!({}, context), [
    { id: "one", name: "one", directory: "/worktrees/one" }, { id: "two", name: "two", directory: "/worktrees/two" },
  ]);
  assert.deepEqual(cursors, [undefined, "next"]); cleanup();
});
