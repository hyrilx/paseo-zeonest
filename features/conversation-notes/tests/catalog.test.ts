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
        ? { notes: [{ sessionId: "a", snippet: "旧设计", createdAt: 5, updatedAt: 10 }, { sessionId: "b", snippet: "发布条目", createdAt: 8, updatedAt: 15 }], unreadable: ["c"] }
        : { notes: [], unreadable: [] };
    },
  } as unknown as Client;
  const catalog = await loadCatalog(client, activity.version, new AbortController().signal);
  assert.deepEqual(pages, [undefined, "next"]);
  assert.deepEqual(batches.map((batch) => batch.length), [PRESENCE_BATCH_SIZE, PRESENCE_BATCH_SIZE, PRESENCE_BATCH_SIZE, 11]);
  assert.deepEqual(catalogRows(catalog, activity).map(({ id, archived, unreadable }) => [id, archived, unreadable]),
    [["b", true, false], ["a", false, false], ["c", false, true]]);
  const rows = catalogRows(catalog, { version: 1, saved: new Map([
    ["a", { version: 1, note: { sessionId: "a", snippet: "刚保存", createdAt: 5, updatedAt: 30 } }], ["b", { version: 1, note: null }],
  ]), drafts: new Map([["unused-0", "# 未保存"]]) });
  assert.deepEqual(rows.find(({ id }) => id === "a"), {
    id: "a", title: "设计", location: "checkout", archived: false, sessionCreatedAt: undefined, sessionUpdatedAt: undefined,
    snippet: "刚保存", noteCreatedAt: 5, noteUpdatedAt: 30, draft: false, unreadable: false,
  });
  assert.equal(rows[0]?.id, "a");
  assert.equal(rows.some(({ id }) => id === "b"), false);
  assert.equal(rows.find(({ id }) => id === "unused-0")?.snippet, "未保存");
});

test("all five sort keys support both directions and keep unknown dates last", async () => {
  const sources = [
    { id: "a", title: "会话 2", createdAt: "2026-11-18", updatedAt: "2026-11-20" },
    { id: "b", title: "会话 10", createdAt: "2026-11-19", updatedAt: "2026-11-19" },
    { id: "c", title: "会话 1", createdAt: "2026-11-17", updatedAt: "2026-11-21" },
    { id: "d", title: "会话 20", createdAt: "invalid" },
  ];
  const client = {
    paseo: { agents: { list: async () => ({ entries: sources.map((agent) => ({ agent })), pageInfo: { hasMore: false } }) } },
    rpc: async () => ({ notes: [
      { sessionId: "a", snippet: "A", createdAt: 10, updatedAt: 40 },
      { sessionId: "b", snippet: "B", createdAt: 20, updatedAt: 20 },
      { sessionId: "c", snippet: "C", createdAt: 30, updatedAt: 30 },
    ], unreadable: ["d"] }),
  } as unknown as Client;
  const catalog = await loadCatalog(client, 0, new AbortController().signal);
  const order = (key: NonNullable<Parameters<typeof catalogRows>[2]>["key"], direction: "asc" | "desc") =>
    catalogRows(catalog, activity, { key, direction }).map(({ id }) => id).join("");
  assert.equal(order("name", "asc"), "cabd");
  assert.equal(order("name", "desc"), "dbac");
  assert.equal(order("noteCreatedAt", "asc"), "abcd");
  assert.equal(order("noteCreatedAt", "desc"), "cbad");
  assert.equal(order("noteUpdatedAt", "asc"), "bcad");
  assert.equal(order("noteUpdatedAt", "desc"), "acbd");
  assert.equal(order("sessionCreatedAt", "asc"), "cabd");
  assert.equal(order("sessionCreatedAt", "desc"), "bacd");
  assert.equal(order("sessionUpdatedAt", "asc"), "bacd");
  assert.equal(order("sessionUpdatedAt", "desc"), "cabd");
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
