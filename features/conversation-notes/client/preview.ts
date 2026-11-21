import { taskParser, type TaskMarker } from "./markdown";

type Node = ReturnType<typeof taskParser.parse>["topNode"];
const MAX_PREVIEW_DEPTH = 64;
export type PreviewPart =
  | { kind: "markdown"; markdown: string }
  | { kind: "text"; markdown: string }
  | { kind: "quote"; content: PreviewPart[] }
  | { kind: "list"; items: PreviewItem[] };
interface PreviewItem { bullet: string; task: (TaskMarker & { label: string }) | null; content: PreviewPart[] }

function children(node: Node) {
  const result: Node[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
  return result;
}
function isList(node: Node) { return node.name === "BulletList" || node.name === "OrderedList"; }
function nodeKey(node: Node) { return `${node.name}:${node.from}:${node.to}`; }

function quotePrefix(line: string, depth: number) {
  let length = 0;
  for (let i = 0; i < depth; i++) {
    const match = /^[\t ]*>[\t ]?/u.exec(line.slice(length));
    if (!match) break;
    length += match[0].length;
  }
  return length;
}
function advanceColumn(column: number, char: string) { return char === "\t" ? column + 4 - column % 4 : column + 1; }

/** Keep the host's Markdown rendering, replacing only containers that need live task controls. */
export function previewMarkdown(markdown: string): PreviewPart[] {
  const tree = taskParser.parse(markdown);
  const containers = new Set<string>();
  const references: Node[] = [];
  let depth = 0;
  let tooDeep = false;
  tree.iterate({
    enter(node) {
      if (tooDeep || depth === MAX_PREVIEW_DEPTH) {
        tooDeep = true;
        return false;
      }
      depth++;
      if (node.name === "LinkReference") references.push(node.node);
      if (node.name === "TaskMarker") {
        for (let parent = node.node.parent; parent; parent = parent.parent) {
          if (parent.name === "Blockquote" || isList(parent)) containers.add(nodeKey(parent));
        }
      }
    },
    leave() { depth--; },
  });
  // Avoid handing an unbounded nesting depth to either renderer.
  if (tooDeep) return [{ kind: "text", markdown }];
  if (!containers.size) return [{ kind: "markdown", markdown }];

  const lineStart = (offset: number) => Math.max(markdown.lastIndexOf("\n", offset - 1), markdown.lastIndexOf("\r", offset - 1)) + 1;
  function localColumn(offset: number, quotes: number) {
    const prefix = markdown.slice(lineStart(offset), offset);
    let column = 0;
    for (const char of prefix.slice(quotePrefix(prefix, quotes))) column = advanceColumn(column, char);
    return column;
  }
  function slice(from: number, to: number, indent: number, quotes: number) {
    const text = markdown.slice(from, to);
    if (!indent && !quotes) return text;
    return text.replace(/(\r\n|\n|\r)([^\r\n]*)/gu, (_line, newline: string, line: string) => {
      let offset = quotePrefix(line, quotes), column = 0;
      while (column < indent && (line[offset] === " " || line[offset] === "\t")) {
        column = advanceColumn(column, line[offset] ?? "");
        offset++;
      }
      return newline + " ".repeat(Math.max(0, column - indent)) + line.slice(offset);
    });
  }

  // References belong to the whole document, even when rendered in different host Markdown fragments.
  const definitions = references.map((node) => {
    let quotes = 0;
    for (let parent = node.parent; parent; parent = parent.parent) if (parent.name === "Blockquote") quotes++;
    return slice(node.from, node.to, localColumn(node.from, quotes), quotes);
  }).join("\n");

  function sequence(from: number, to: number, nodes: Node[], indent: number, quotes: number) {
    const parts: PreviewPart[] = [];
    let cursor = from;
    function plain(end: number) {
      const body = slice(cursor, end, indent, quotes);
      if (body.trim()) parts.push({ kind: "markdown", markdown: definitions ? definitions + "\n\n" + body : body });
    }
    for (const node of nodes) {
      if (!containers.has(nodeKey(node))) continue;
      plain(node.from);
      if (isList(node)) {
        let number = Number.parseInt(markdown.slice(node.from, node.to), 10) || 0;
        parts.push({ kind: "list", items: children(node).filter((item) => item.name === "ListItem").map((item) => {
          const mark = item.getChild("ListMark");
          const inner = item.getChild("Task");
          const marker = inner?.getChild("TaskMarker");
          const afterMark = mark?.to ?? item.from;
          const gap = /^[\t ]*/u.exec(markdown.slice(afterMark, item.to))?.[0].length ?? 0;
          const markColumn = localColumn(afterMark, quotes);
          const firstColumn = localColumn(afterMark + gap, quotes);
          const itemIndent = firstColumn - markColumn <= 4 && gap ? firstColumn : markColumn + 1;
          const start = marker?.to ?? afterMark;
          const body = start + (/^[\t ]*/u.exec(markdown.slice(start, item.to))?.[0].length ?? 0);
          const label = /^[^\r\n]*/u.exec(markdown.slice(body, item.to))?.[0].trim() || "待办";
          const task = marker ? { from: marker.from, to: marker.to, bodyEnd: inner?.to ?? marker.to,
            checked: markdown[marker.from + 1] !== " ", label } : null;
          return { bullet: node.name === "OrderedList" ? `${number++}.` : "•", task,
            content: sequence(body, item.to, children(item), itemIndent, quotes) };
        }) });
      } else {
        const contents = children(node).filter((child) => child.name !== "QuoteMark");
        if (contents[0]) parts.push({ kind: "quote", content: sequence(contents[0].from, node.to, contents, 0, quotes + 1) });
      }
      cursor = node.to;
    }
    plain(to);
    return parts;
  }
  return sequence(0, markdown.length, children(tree.topNode), 0, 0);
}
