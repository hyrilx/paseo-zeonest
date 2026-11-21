import type { PluginClientContext } from "@getpaseo/plugin/client";
import { noteSummaries, PRESENCE_BATCH_SIZE, type NoteSummary } from "../shared/contracts";
import { noteSnippet } from "../shared/snippet";

type Client = Pick<PluginClientContext, "paseo" | "rpc">;
export interface NoteSource {
  id: string;
  title: string;
  location: string;
  archived: boolean;
  sessionCreatedAt: number | undefined;
  sessionUpdatedAt: number | undefined;
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
export type CatalogRow = NoteSource & {
  snippet: string;
  noteCreatedAt: number | undefined;
  noteUpdatedAt: number | undefined;
  draft: boolean;
  unreadable: boolean;
};

export const sortOptions = [
  { key: "name", label: "名称" },
  { key: "noteCreatedAt", label: "笔记创建时间" },
  { key: "noteUpdatedAt", label: "笔记更新时间" },
  { key: "sessionCreatedAt", label: "对话创建时间" },
  { key: "sessionUpdatedAt", label: "对话更新时间" },
] as const;
export type NoteSort = { key: typeof sortOptions[number]["key"]; direction: "asc" | "desc" };
export const defaultSort: NoteSort = { key: "noteUpdatedAt", direction: "desc" };

function parseDate(value: string | undefined) {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

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
        sessionCreatedAt: parseDate(agent.createdAt),
        sessionUpdatedAt: parseDate(agent.updatedAt),
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

export function catalogRows(catalog: Catalog, activity: NoteActivity, sort: NoteSort = defaultSort, anchor?: CatalogRow): CatalogRow[] {
  const rows: CatalogRow[] = [];
  for (const source of catalog.sources.values()) {
    const saved = activity.saved.get(source.id);
    const recent = saved && saved.version > catalog.since ? saved : undefined;
    const note = recent ? recent.note : catalog.notes.get(source.id);
    const draft = activity.drafts.get(source.id);
    const unreadable = !recent && catalog.unreadable.has(source.id);
    if (!note && draft === undefined && !unreadable) continue;
    rows.push({ ...source, snippet: draft === undefined ? note?.snippet ?? "" : noteSnippet(draft),
      noteCreatedAt: note?.createdAt, noteUpdatedAt: note?.updatedAt, draft: draft !== undefined, unreadable });
  }
  // Clearing the body must not unmount the open editor. Its own autosave also must not move it mid-edit.
  if (anchor && !rows.some(({ id }) => id === anchor.id)) rows.push({ ...anchor, snippet: "", draft: false, unreadable: false });
  const { key, direction } = sort;
  const sign = direction === "asc" ? 1 : -1;
  const compareName = (left: CatalogRow, right: CatalogRow) => left.title.localeCompare(right.title, "zh-CN", { numeric: true });
  return rows.sort((aRow, bRow) => {
    const left = aRow.id === anchor?.id ? anchor : aRow;
    const right = bRow.id === anchor?.id ? anchor : bRow;
    let order: number;
    if (key === "name") order = sign * compareName(left, right);
    else {
      const a = left[key], b = right[key];
      if (a === undefined && b !== undefined) return 1;
      if (b === undefined && a !== undefined) return -1;
      order = a === undefined || b === undefined ? 0 : sign * (a - b);
    }
    return order || compareName(left, right) || left.id.localeCompare(right.id);
  });
}
