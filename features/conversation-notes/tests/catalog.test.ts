import assert from "node:assert/strict";
import test from "node:test";
import { catalogRows, loadCatalog, type NoteActivity } from "../client/catalog";
import { MAX_SNIPPET_LENGTH, noteSummaries, PRESENCE_BATCH_SIZE } from "../shared/contracts";
import { noteSnippet } from "../shared/snippet";
import { deferred } from "./deferred";

type Client = Parameters<typeof loadCatalog>[0];
const source = (id: string, title: string, archivedAt: string | null = null) => ({ agent: { id, title, archivedAt, cwd: "/user/checkout" } });
const activity: NoteActivity = { version: 0, drafts: new Map(), saved: new Map() };

test("catalog reads every directory page and overlays newer saves and drafts on a stale list", async () => {
  const batches: string[][] = [];
  const pages: (string | undefined)[] = [];
  const entries = Array.from({ length: 200 }, (_, i) => source(`unused-${i}`, `无笔记会话 ${i}`));
  const client = {
    paseo: { agents: { async list(query: { page: { cursor?: string } }) {
      pages.push(query.page.cursor);
      if (!query.page.cursor) return { entries, pageInfo: { hasMore: true, nextCursor: "next" } };
      return { entries: [source("a", "设计"), source("b", "发布", "2026-11-20"), source("c", "问题")], pageInfo: { hasMore: false } };
    } } },
    async rpc({ name }: { name: string }, { sessionIds }: { sessionIds: string[] }) {
      assert.equal(name, noteSummaries.name);
      batches.push(sessionIds);
      return sessionIds.includes("a")
        ? { notes: [{ sessionId: "a", snippet: "旧设计", updatedAt: 10 }, { sessionId: "b", snippet: "发布条目", updatedAt: 15 }], unreadable: ["c"] }
        : { notes: [], unreadable: [] };
    },
  } as unknown as Client;
  const catalog = await loadCatalog(client, activity.version, new AbortController().signal);
  assert.deepEqual(pages, [undefined, "next"]);
  assert.deepEqual(batches.map((batch) => batch.length), [PRESENCE_BATCH_SIZE, PRESENCE_BATCH_SIZE, PRESENCE_BATCH_SIZE, 11]);
  assert.deepEqual(catalogRows(catalog, activity).map(({ id, archived, unreadable }) => [id, archived, unreadable]),
    [["b", true, false], ["a", false, false], ["c", false, true]]);
  const rows = catalogRows(catalog, { version: 1, saved: new Map([
    ["a", { version: 1, note: { sessionId: "a", snippet: "刚保存", updatedAt: 30 } }], ["b", { version: 1, note: null }],
  ]), drafts: new Map([["unused-0", "# 未保存"]]) });
  assert.deepEqual(rows.map(({ id, snippet, draft }) => [id, snippet, draft]),
    [["unused-0", "未保存", true], ["a", "刚保存", false], ["c", "", false]]);
  assert.equal(rows[1]?.location, "checkout");
});

test("an abandoned catalog ignores a late summary and an invalid cursor is rejected", async () => {
  const summary = deferred<{ notes: []; unreadable: [] }>();
  let started = false;
  const client = {
    paseo: { agents: { list: async () => ({ entries: [source("id", "会话")], pageInfo: { hasMore: false } }) } },
    rpc: () => { started = true; return summary.promise; },
  } as unknown as Client;
  const abort = new AbortController();
  const pending = loadCatalog(client, 0, abort.signal);
  await Promise.resolve();
  assert.equal(started, true);
  abort.abort();
  summary.resolve({ notes: [], unreadable: [] });
  await assert.rejects(pending, /已取消/);
  const looping = { ...client, paseo: { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: true, nextCursor: "repeat" } }) } } } as unknown as Client;
  await assert.rejects(loadCatalog(looping, 0, new AbortController().signal), /分页无效/);
});

test("snippets stay bounded, strip list syntax, and do not split an emoji", () => {
  assert.equal(noteSnippet("# 标题\n> - [X] 第一项\n\n  2. 第二项"), "标题 第一项 第二项");
  assert.equal(noteSnippet("a".repeat(MAX_SNIPPET_LENGTH - 2) + "🙂后文"), "a".repeat(MAX_SNIPPET_LENGTH - 2) + "…");
  assert.equal(noteSnippet("> ".repeat(8000) + "正文"), "正文");
});
