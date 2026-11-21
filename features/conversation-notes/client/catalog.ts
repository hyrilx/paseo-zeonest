import type { PluginClientContext } from "@getpaseo/plugin/client";
import { noteSummaries, PRESENCE_BATCH_SIZE, type NoteSummary } from "../shared/contracts";
import { noteSnippet } from "../shared/snippet";

type Client = Pick<PluginClientContext, "paseo" | "rpc">;
export interface NoteSource {
  id: string;
  title: string;
  location: string;
  archived: boolean;
}
interface Catalog {
  sources: Map<string, NoteSource>;
  notes: Map<string, NoteSummary>;
  unreadable: Set<string>;
  since: number;
}
export interface NoteActivity {
  version: number;
  drafts: ReadonlyMap<string, string>;
  saved: ReadonlyMap<string, { version: number; note: NoteSummary | null }>;
}
export type CatalogRow = NoteSource & { snippet: string; updatedAt: number; draft: boolean; unreadable: boolean };

export async function loadCatalog(client: Client, since: number, signal: AbortSignal): Promise<Catalog> {
  const sources = new Map<string, NoteSource>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  const sort = [{ key: "created_at", direction: "asc" }] as const;
  const check = () => { if (signal.aborted) throw new Error("笔记列表读取已取消"); };
  do {
    check();
    const { entries, pageInfo } = await client.paseo.agents.list({
      filter: { includeArchived: true, includeBackground: true }, sort: [...sort], page: { limit: 200, cursor }, signal,
    });
    check();
    for (const { agent, project } of entries) {
      if (!agent.id || agent.id.length > 256) continue;
      sources.set(agent.id, {
        id: agent.id,
        title: agent.title?.trim() || `未命名会话 · ${agent.id.slice(0, 8)}`,
        location: project ? [project.projectName, project.workspaceName].filter(Boolean).join(" / ")
          : agent.cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? "",
        archived: !!agent.archivedAt,
      });
    }
    if (!pageInfo.hasMore) break;
    const next = pageInfo.nextCursor;
    if (!next || cursors.has(next)) throw new Error("会话目录分页无效");
    cursors.add(next);
    cursor = next;
  } while (cursor);

  const notes = new Map<string, NoteSummary>(), unreadable = new Set<string>();
  const ids = [...sources.keys()];
  for (let index = 0; index < ids.length; index += PRESENCE_BATCH_SIZE) {
    check();
    const { notes: batch, unreadable: failed } = await client.rpc(noteSummaries, { sessionIds: ids.slice(index, index + PRESENCE_BATCH_SIZE) });
    check();
    for (const note of batch) notes.set(note.sessionId, note);
    for (const id of failed) unreadable.add(id);
  }
  return { sources, notes, unreadable, since };
}

export function catalogRows(catalog: Catalog, activity: NoteActivity): CatalogRow[] {
  const rows: CatalogRow[] = [];
  for (const source of catalog.sources.values()) {
    const saved = activity.saved.get(source.id);
    const recent = saved && saved.version > catalog.since ? saved : undefined;
    const note = recent ? recent.note : catalog.notes.get(source.id);
    const draft = activity.drafts.get(source.id);
    const unreadable = !recent && catalog.unreadable.has(source.id);
    if (!note && draft === undefined && !unreadable) continue;
    rows.push({ ...source, snippet: draft === undefined ? note?.snippet ?? "" : noteSnippet(draft),
      updatedAt: note?.updatedAt ?? 0, draft: draft !== undefined, unreadable });
  }
  return rows.sort((left, right) => +right.draft - +left.draft || right.updatedAt - left.updatedAt || left.title.localeCompare(right.title));
}
