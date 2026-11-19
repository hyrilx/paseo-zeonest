import { createTwoFilesPatch, parsePatch } from "diff";
import type { Activity, Kind, Projection, RecordEntry, ToolItem } from "./types";

export const kinds: { value: Kind; label: string }[] = [
  { value: "create", label: "新增" }, { value: "delete", label: "删除" },
  { value: "edit", label: "修改" }, { value: "read", label: "查询" },
];
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === "string" ? value : undefined;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const pathOf = (value: Record<string, unknown>) => string(value.filePath) ?? string(value.file_path) ?? string(value.path);
const defined = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, value]) => value !== undefined));
export function mergeRecords(records: RecordEntry[]): RecordEntry[] {
  const merged = new Map<string, RecordEntry>();
  for (const entry of [...records].sort((a, b) => (a.updatedSeq ?? a.seq) - (b.updatedSeq ?? b.seq))) {
    const item = entry.item;
    const key = item.type === "tool_call" ? "tool:" + item.callId : item.type === "user_message"
      ? "user:" + (item.messageId ?? item.clientMessageId ?? entry.turnId ?? entry.seq) : "seq:" + entry.seq;
    const previous = merged.get(key);
    if (previous && previous.item.type === "tool_call" && item.type === "tool_call") {
      const old = previous.item;
      const detail = old.detail.type === item.detail.type ? { ...old.detail, ...defined(object(item.detail)) } : item.detail;
      merged.set(key, { ...entry, seq: previous.seq, updatedSeq: entry.updatedSeq ?? entry.seq,
        timestamp: previous.timestamp ?? entry.timestamp, turnId: previous.turnId ?? entry.turnId,
        item: { ...old, ...item, detail } as ToolItem });
    } else if (!previous) merged.set(key, entry);
  }
  return [...merged.values()].sort((a, b) => a.seq - b.seq);
}
type FileDetail = Pick<Activity, "path" | "kind" | "content" | "diff" | "range" | "note">;
function snippet(path: string, before: string, after: string) {
  // These are tool-provided fragments, not necessarily the whole file.
  if (before.length + after.length > 400_000) return undefined;
  return createTwoFilesPatch(path, path, before, after, "", "", { context: 3, timeout: 50 });
}
function patchDetails(patch: string): FileDetail[] {
  if (patch.includes("*** Begin Patch")) {
    const lines = patch.split(/\r?\n/);
    const files: FileDetail[] = [];
    let current: { path: string; kind: Kind; lines: string[]; move?: string } | undefined;
    const flush = () => {
      if (!current) return;
      files.push({ path: current.path, kind: current.kind,
        ...(current.kind === "create" ? { content: current.lines.map((line) => line.startsWith("+") ? line.slice(1) : line).join("\n") + "\n" }
          : current.kind === "edit" ? { diff: current.lines.join("\n") } : {}),
        note: current.move ? "移动到 " + current.move : current.kind === "delete" ? "补丁未包含删除前的正文。" : undefined });
    };
    for (const line of lines) {
      const header = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(line);
      if (header) { flush(); current = { path: header[2]!, kind: header[1] === "Add" ? "create" : header[1] === "Delete" ? "delete" : "edit", lines: [] }; }
      else if (line.startsWith("*** Move to: ") && current) current.move = line.slice(13);
      else if (line === "*** End Patch") { flush(); current = undefined; }
      else if (current && line !== "*** End of File") current.lines.push(line);
    }
    flush();
    return files;
  }
  try {
    return parsePatch(patch).flatMap((file) => {
      const added = file.oldFileName === "/dev/null";
      const deleted = file.newFileName === "/dev/null";
      const path = deleted ? file.oldFileName : file.newFileName;
      if (!path) return [];
      const content = added ? file.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.startsWith("+")).map((line) => line.slice(1))).join("\n") + (file.hunks.at(-1)?.lines.at(-1)?.startsWith("\\ No newline") ? "" : "\n") : undefined;
      return [{ path: path.replace(/^[ab]\//, ""), kind: added ? "create" : deleted ? "delete" : "edit",
        content, diff: added ? undefined : [
          "--- " + file.oldFileName, "+++ " + file.newFileName,
          ...file.hunks.flatMap((hunk) => ["@@ -" + hunk.oldStart + "," + hunk.oldLines + " +" + hunk.newStart + "," + hunk.newLines + " @@", ...hunk.lines]),
        ].join("\n"),
        note: file.oldFileName !== file.newFileName && !added && !deleted && file.oldFileName?.replace(/^[ab]\//, "") !== path.replace(/^[ab]\//, "")
          ? "原路径：" + file.oldFileName : undefined } satisfies FileDetail];
    });
  } catch { return []; }
}
function readRange(input: Record<string, unknown>) {
  const offset = number(input.offset) ?? number(input.start_line);
  const limit = number(input.limit);
  const end = number(input.end_line);
  if (offset !== undefined && end !== undefined) return "第 " + offset + "–" + end + " 行（工具参数）";
  if (offset !== undefined && limit !== undefined) return "起始行 " + offset + "，请求 " + limit + " 行（工具参数）";
  if (offset !== undefined) return "起始行 " + offset + "，结束位置未记录";
  if (limit !== undefined) return "请求最多 " + limit + " 行，起始位置未记录";
  return "工具未记录行范围；不能据此判断读取了全文。";
}
function textOutput(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const content = object(value).content;
  return Array.isArray(content) ? content.flatMap((part) => string(object(part).text) ?? []).join("\n") : undefined;
}
function details(tool: ToolItem): FileDetail[] {
  const detail = tool.detail;
  if (detail.type === "read") return [{ path: detail.filePath, kind: "read", content: detail.content, range: readRange(object(detail)) }];
  if (detail.type === "write") return [{ path: detail.filePath, kind: "edit", content: detail.content, note: "写入操作；记录未说明此前是否存在该文件，归入修改。正文为工具提交的内容。" }];
  if (detail.type === "edit") {
    const files = detail.unifiedDiff ? patchDetails(detail.unifiedDiff) : [];
    if (files.length) return files;
    const diff = detail.unifiedDiff ?? (detail.oldString !== undefined && detail.newString !== undefined ? snippet(detail.filePath, detail.oldString, detail.newString) : undefined);
    return [{ path: detail.filePath, kind: "edit", diff,
      note: detail.unifiedDiff ? undefined : "差异来自工具提供的替换片段；行号相对于片段。超过 400000 字符或计算超过 50ms 的片段不在客户端生成 diff。" }];
  }
  if (detail.type === "search") {
    if (detail.toolName === "web_search") return [];
    return [...new Set(detail.filePaths ?? [])].map((path) => ({ path, kind: "read", range: "搜索：" + detail.query,
      note: "工具返回的匹配路径；未提供每个文件的确切查看范围。" }));
  }
  if (detail.type !== "unknown") return [];
  const name = tool.name.toLowerCase().split(/[./]/).at(-1) ?? "";
  const input = object(detail.input);
  const path = pathOf(input);
  if (name === "apply_patch") return patchDetails(string(detail.input) ?? string(input.patch) ?? string(input.input) ?? "");
  if (!path) return [];
  const content = string(input.content) ?? string(input.text);
  if (["read", "read_file"].includes(name)) return [{ path, kind: "read", content: textOutput(detail.output), range: readRange(input) }];
  if (["delete_file", "remove_file"].includes(name)) return [{ path, kind: "delete", note: "工具未提供删除前的正文。" }];
  if (name === "create_file") return [{ path, kind: "create", content }];
  if (["write", "write_file"].includes(name)) return [{ path, kind: "edit", content, note: "写入操作；无法从记录确认新增还是覆盖，归入修改。" }];
  if (["edit", "edit_file"].includes(name)) {
    const replacements = Array.isArray(input.edits) ? input.edits : [input];
    return replacements.map((replacement) => {
      const part = object(replacement);
      const before = string(part.oldText) ?? string(part.old_string) ?? string(part.oldString);
      const after = string(part.newText) ?? string(part.new_string) ?? string(part.newString);
      return { path, kind: "edit", diff: before !== undefined && after !== undefined ? snippet(path, before, after) : undefined,
        note: "差异来自工具提供的替换片段；行号相对于片段。" };
    });
  }
  return [];
}
export function projectActivity(input: RecordEntry[]): Projection {
  const records = mergeRecords(input);
  const turns: Projection["turns"] = [];
  const byId = new Map<string, Projection["turns"][number]>();
  const activities: Activity[] = [];
  let current = "unassigned";
  const ensure = (id: string, title: string) => {
    if (!byId.has(id)) { const turn = { id, number: turns.length + 1, title }; turns.push(turn); byId.set(id, turn); }
    else if (title !== "未提供用户消息") byId.get(id)!.title = title;
  };
  for (const entry of records) {
    const item = entry.item;
    if (item.type === "user_message") {
      current = entry.turnId ?? item.messageId ?? item.clientMessageId ?? "user:" + entry.seq;
      ensure(current, item.text.replace(/\s+/g, " ").slice(0, 100) || "（空消息）");
    } else if (item.type === "tool_call") {
      const turnId = entry.turnId ?? current;
      ensure(turnId, turnId === "unassigned" ? "未归属轮次" : "未提供用户消息");
      details(item).forEach((file, index) => {
        if (!file.path || /^(?:https?|data):/i.test(file.path)) return;
        activities.push({ ...file, id: item.callId + ":" + index, callId: item.callId, tool: item.name,
          status: item.status, turnId, seq: entry.seq, timestamp: entry.timestamp });
      });
    }
  }
  return { turns, activities };
}
export function selectActivities(projection: Projection, turnId: string | null, filter: Kind[], sort: "time" | "kind" | "path", descending: boolean, includeUnsuccessful: boolean) {
  const rank = (kind: Kind) => kinds.findIndex((item) => item.value === kind);
  return projection.activities.filter((item) => (turnId === null || item.turnId === turnId) && filter.includes(item.kind)
    && (includeUnsuccessful || item.status === "completed")).sort((a, b) => {
      const primary = sort === "kind" ? rank(a.kind) - rank(b.kind) : sort === "path" ? a.path.localeCompare(b.path) : a.seq - b.seq;
      return (primary || a.seq - b.seq || a.id.localeCompare(b.id)) * (descending ? -1 : 1);
    });
}
