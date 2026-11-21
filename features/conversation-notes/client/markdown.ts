import { parser, TaskList } from "@lezer/markdown";

export interface Selection { start: number; end: number }
export type Format = "bold" | "strike" | "heading" | "bullet" | "checklist" | "toggle-task";
interface Edit { from: number; to: number; text: string }
export interface TaskMarker { from: number; to: number; bodyEnd: number; checked: boolean }

export const taskParser = parser.configure(TaskList);

export function taskMarkers(markdown: string): TaskMarker[] {
  const markers: TaskMarker[] = [];
  taskParser.parse(markdown).iterate({ enter(node) {
    if (node.name === "TaskMarker") {
      markers.push({ from: node.from, to: node.to, bodyEnd: node.node.parent?.to ?? node.to, checked: markdown[node.from + 1] !== " " });
    }
  } });
  return markers;
}

export function toggleTaskMarker(markdown: string, marker: TaskMarker) {
  const token = markdown.slice(marker.from, marker.to);
  if (!/^\[[ xX]\]$/u.test(token) || (token[1] !== " ") !== marker.checked) return markdown;
  return markdown.slice(0, marker.from + 1) + (marker.checked ? " " : "x") + markdown.slice(marker.from + 2);
}

function replace(markdown: string, selection: Selection, edits: Edit[]) {
  const move = (offset: number) => {
    let shift = 0;
    for (const { from, to, text } of edits) {
      if (offset < from) break;
      if (offset < to) return from + shift + text.length;
      shift += text.length - (to - from);
    }
    return offset + shift;
  };
  let output = "", cursor = 0;
  for (const { from, to, text } of edits) {
    output += markdown.slice(cursor, from) + text;
    cursor = to;
  }
  return { markdown: output + markdown.slice(cursor), selection: { start: move(selection.start), end: move(selection.end) } };
}

function wrap(markdown: string, { start, end }: Selection, marker: string) {
  const before = markdown.slice(0, start), after = markdown.slice(end);
  const middle = markdown.slice(start, end);
  const size = marker.length;
  if (before.endsWith(marker) && after.startsWith(marker)) {
    return { markdown: before.slice(0, -size) + middle + after.slice(size), selection: { start: start - size, end: end - size } };
  }
  if (middle.length >= 2 * size && middle.startsWith(marker) && middle.endsWith(marker)) {
    return { markdown: before + middle.slice(size, -size) + after, selection: { start, end: end - size * 2 } };
  }
  return { markdown: before + marker + middle + marker + after, selection: { start: start + size, end: end + size } };
}

function formatLines(markdown: string, selection: Selection, format: "heading" | "bullet" | "checklist") {
  const { start, end } = selection;
  const lines = markdown.split(/(\r\n|\r|\n)/u);
  const selected: { from: number; prefix: string; kind: "heading" | "checklist" | "bullet" | "ordered" | "plain"; text: string }[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i] ?? "";
    const next = offset + line.length + (lines[i + 1]?.length ?? 0);
    if ((start < next || i === lines.length - 1) && (offset < end || start === end && offset <= start)) {
      const indent = /^[\t ]*(?:>[\t ]*)*/u.exec(line)?.[0] ?? "";
      const text = line.slice(indent.length);
      const heading = /^#{1,6}(?:[\t ]+|$)/u.exec(text)?.[0];
      const list = /^(?:[-+*]|\d{1,9}[.)])(?:[\t ]+|$)/u.exec(text)?.[0];
      const task = list && /^\[[ xX]\](?:[\t ]+|$)/u.exec(text.slice(list.length))?.[0];
      let kind: (typeof selected)[number]["kind"] = "plain";
      if (heading) kind = "heading";
      else if (task) kind = "checklist";
      else if (list) kind = /^\d/u.test(list) ? "ordered" : "bullet";
      selected.push({ from: offset + indent.length, prefix: heading || (list ? list + (task || "") : ""), kind, text });
    }
    offset = next;
  }
  const linesToChange = selected.length > 1 ? selected.filter(({ text }) => text.trim()) : selected;
  const affected = linesToChange.length ? linesToChange : selected.slice(0, 1);
  const remove = affected.every(({ kind }) => kind === format);
  const edits = affected.flatMap(({ from, prefix, kind }) => {
    if (!remove && kind === format) return [];
    const text = remove ? "" : { heading: "## ", bullet: "- ", checklist: "- [ ] " }[format];
    return [{ from, to: from + prefix.length, text }];
  });
  return replace(markdown, selection, edits);
}

export function formatMarkdown(markdown: string, range: Selection, format: Format) {
  const selection = { start: Math.max(0, Math.min(range.start, markdown.length)), end: Math.max(0, Math.min(range.end, markdown.length)) };
  if (format === "bold" || format === "strike") return wrap(markdown, selection, format === "bold" ? "**" : "~~");
  if (format === "toggle-task") {
    const { start, end } = selection;
    const markers = taskMarkers(markdown).filter(({ from, bodyEnd }) => {
      const lineStart = Math.max(markdown.lastIndexOf("\n", from - 1), markdown.lastIndexOf("\r", from - 1)) + 1;
      return bodyEnd >= start && (start === end ? lineStart <= end : lineStart < end);
    });
    const text = markers.some(({ checked }) => !checked) ? "x" : " ";
    return replace(markdown, selection, markers.map(({ from }) => ({ from: from + 1, to: from + 2, text })));
  }
  return formatLines(markdown, selection, format);
}
