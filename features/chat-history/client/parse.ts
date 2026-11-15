export interface HistoryMessage {
  histories: string[];
  body: string;
}

export type HistoryRole = "meta" | "user" | "assistant" | "action";
export interface HistoryEntry {
  role: HistoryRole;
  label: string;
  text: string;
}
export interface ParsedHistory {
  entries: HistoryEntry[];
  source: string | null;
  omitted: boolean;
  truncated: boolean;
}

const OPEN = "<chat-history-summary>";
const CLOSE = "</chat-history-summary>";

/** Track literal code so examples and labels inside fences are not mistaken for structure. */
function* scanLines(text: string) {
  let offset = 0;
  let fence: { character: string; length: number } | null = null;
  let inline = 0;
  for (const chunk of text.split(/(?<=\n)/)) {
    const line = chunk.replace(/\r?\n$/, "");
    const protectedStart = fence !== null || inline > 0;
    const tags: { value: string; start: number; end: number }[] = [];
    // A wrapper may share its first line with a message and that message's code fence.
    const prefix = !protectedStart ? /^(?:<\/?chat-history-summary>[ \t]*)+/.exec(line)?.[0] ?? "" : "";
    for (const token of prefix.matchAll(/<\/?chat-history-summary>/g)) {
      tags.push({ value: token[0], start: offset + token.index, end: offset + token.index + token[0].length });
    }
    const content = line.slice(prefix.length);
    // The curator prefixes the first line of a message, including a leading code fence.
    const candidate = fence ? content : content.replace(/^\[(?:User|Assistant)\][ \t]+/, "");
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(candidate);
    if (fence) {
      if (marker && marker[1]![0] === fence.character && marker[1]!.length >= fence.length && !marker[2]!.trim()) {
        fence = null;
      }
    } else if (!inline && marker && !(marker[1]![0] === "`" && marker[2]!.includes("`"))) {
      fence = { character: marker[1]![0]!, length: marker[1]!.length };
    } else {
      for (const token of content.matchAll(/`+|<\/?chat-history-summary>/g)) {
        const value = token[0];
        const start = prefix.length + token.index;
        if (line[start - 1] === "\\") continue;
        if (value[0] === "`") {
          if (!inline) inline = value.length;
          else if (inline === value.length) inline = 0;
        } else if (!inline) {
          tags.push({ value, start: offset + start, end: offset + start + value.length });
        }
      }
    }
    yield { line, protectedStart, tags };
    offset += chunk.length;
  }
}

/** Extract balanced summaries without changing any text outside their delimiters. */
export function splitHistoryMessage(text: string): HistoryMessage | null {
  if (!text.includes(OPEN)) return null;
  const histories: string[] = [];
  const body: string[] = [];
  let depth = 0;
  let start = 0;
  let contentStart = 0;
  let previousEnd = 0;
  for (const { tags } of scanLines(text)) {
    for (const tag of tags) {
      if (tag.value === OPEN) {
        if (depth === 0) {
          start = tag.start;
          contentStart = tag.end;
        }
        depth++;
      } else if (tag.value === CLOSE) {
        if (depth === 0) return null;
        depth--;
        if (depth === 0) {
          body.push(text.slice(previousEnd, start));
          histories.push(text.slice(contentStart, tag.start));
          previousEnd = tag.end;
        }
      }
    }
  }
  // A partial or malformed wrapper stays entirely in the native message.
  if (depth !== 0 || histories.length === 0) return null;
  body.push(text.slice(previousEnd));
  return { histories, body: body.join("") };
}

function roleFor(label: string): HistoryRole {
  switch (label.toLowerCase()) {
    case "user": return "user";
    case "assistant": return "assistant";
    case "meta":
    case "system":
    case "thought": return "meta";
    default: return "action";
  }
}

/** Paseo's summary is a lossy line-oriented format, not a structured transcript. */
export function parseHistory(text: string): ParsedHistory {
  const entries: HistoryEntry[] = [];
  let current: HistoryEntry = { role: "meta", label: "Meta", text: "" };
  let nested = 0;
  let omitted = false;
  let truncated = false;
  const flush = () => {
    const body = current.text.trim();
    if (body || current.role !== "meta") entries.push({ ...current, text: body });
  };
  for (const { line, protectedStart, tags } of scanLines(text)) {
    const structural = !protectedStart && nested === 0;
    const notice = structural && (line === "[Earlier chat history omitted]" || line === "[Message truncated]");
    if (notice) {
      omitted ||= line === "[Earlier chat history omitted]";
      truncated ||= line === "[Message truncated]";
    }
    const marker = structural && !notice ? /^\[([^\]\r\n]{1,160})\](?:[ \t]+(.*))?$/.exec(line) : null;
    if (marker) {
      flush();
      const label = marker[1]!;
      current = { role: roleFor(label), label, text: marker[2] ?? "" };
    } else {
      current.text += `${current.text ? "\n" : ""}${line}`;
    }
    for (const tag of tags) nested = Math.max(0, nested + (tag.value === OPEN ? 1 : -1));
  }
  flush();
  const metadata = entries[0]?.role === "meta" ? entries[0].text : "";
  const source = /^Source agent:[ \t]*(.+)$/m.exec(metadata)?.[1]?.trim() ?? null;
  return { entries, source, omitted, truncated };
}
