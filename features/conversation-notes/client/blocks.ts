export type BlockContent =
  | { kind: "paragraph" | "heading" | "bullet"; text: string }
  | { kind: "task"; text: string; checked: boolean };
export type Block = BlockContent & { id: number };

export function emptyBlock(): BlockContent {
  return { kind: "paragraph", text: "" };
}

// The first release interprets block markers only. Inline Markdown is ordinary text here.
function fromLine(text: string): BlockContent {
  const task = /^- \[([ xX])\](?: |$)/u.exec(text);
  if (task) return { kind: "task", checked: task[1] !== " ", text: text.slice(task[0].length) };
  if (text.startsWith("- ")) return { kind: "bullet", text: text.slice(2) };
  if (text.startsWith("# ")) return { kind: "heading", text: text.slice(2) };
  return { kind: "paragraph", text };
}

export function parseMarkdown(markdown: string): BlockContent[] {
  return markdown.replace(/\r\n?/gu, "\n").split("\n").map(fromLine);
}

export function toMarkdown(blocks: readonly BlockContent[]): string {
  return blocks.map((block) => {
    switch (block.kind) {
      case "heading": return "# " + block.text;
      case "bullet": return "- " + block.text;
      case "task": return "- [" + (block.checked ? "x" : " ") + "] " + block.text;
      case "paragraph": return block.text;
    }
  }).join("\n");
}

function editLine(block: BlockContent, text: string): BlockContent {
  if (block.kind === "paragraph") return fromLine(text);
  if (block.kind === "bullet") {
    // "- " has already disappeared from the input by the time "[ ] " is typed.
    const task = /^\[([ xX])\] /u.exec(text);
    if (task) return { kind: "task", checked: task[1] !== " ", text: text.slice(task[0].length) };
  }
  return { ...block, text };
}

function continuation(block: BlockContent): BlockContent {
  if (block.kind === "bullet") return { kind: "bullet", text: "" };
  if (block.kind === "task") return { kind: "task", checked: false, text: "" };
  return emptyBlock();
}

export function editBlock(block: BlockContent, value: string) {
  const text = value.replace(/\r\n?/gu, "\n");
  const lines = text.split("\n");
  const first = editLine(block, lines[0]!);
  const blocks = [first, ...lines.slice(1).map((line) => {
    const parsed = fromLine(line);
    return parsed.kind === "paragraph" ? editLine(continuation(first), line) : parsed;
  })];
  if (lines.length === 1) return { blocks, focus: null };
  // Preserve the suffix after a caret split without moving the caret to the end of that suffix.
  // Stop at the last inserted line even when the old suffix shares a newline-like paste pattern.
  const tail = lines[lines.length - 1]!;
  let suffix = 0;
  while (suffix < tail.length && suffix < block.text.length && tail.at(-suffix - 1) === block.text.at(-suffix - 1)) suffix++;
  const target = blocks[blocks.length - 1]!;
  return { blocks, focus: { index: blocks.length - 1, offset: Math.max(0, target.text.length - suffix) } };
}
