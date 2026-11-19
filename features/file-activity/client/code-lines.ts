export type CodeLine = { text: string; kind: "context" | "add" | "remove" | "hunk" | "meta"; old?: number; next?: number };
export function codeLines(text: string, diff: boolean): CodeLine[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (!diff) return lines.map((text, index) => ({ text, kind: "context", next: index + 1 }));
  let old: number | undefined;
  let next: number | undefined;
  let inHunk = false;
  let oldRemaining = 0;
  let nextRemaining = 0;
  return lines.map((text): CodeLine => {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (text.startsWith("@@")) {
      old = hunk ? Number(hunk[1]) : undefined; next = hunk ? Number(hunk[3]) : undefined;
      oldRemaining = hunk ? Number(hunk[2] ?? 1) : 0; nextRemaining = hunk ? Number(hunk[4] ?? 1) : 0;
      inHunk = !hunk || oldRemaining + nextRemaining > 0;
      return { text, kind: "hunk" };
    }
    if (text.startsWith("\\") || (!inHunk && (text.startsWith("--- ") || text.startsWith("+++ ")))) return { text, kind: "meta" };
    const kind = text.startsWith("+") ? "add" : text.startsWith("-") ? "remove" : text.startsWith(" ") ? "context" : "meta";
    const row: CodeLine = { text, kind };
    if (inHunk && kind !== "meta") {
      if (kind !== "add" && old !== undefined) { row.old = old++; oldRemaining--; }
      if (kind !== "remove" && next !== undefined) { row.next = next++; nextRemaining--; }
      if (old !== undefined && next !== undefined && oldRemaining <= 0 && nextRemaining <= 0) inHunk = false;
    }
    return row;
  });
}
