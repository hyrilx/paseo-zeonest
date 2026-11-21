import { MAX_SNIPPET_LENGTH } from "./contracts";

/** A short text excerpt, not rendered Markdown or a full-text index. */
export function noteSnippet(markdown: string): string {
  const excerpt = markdown.split(/\r?\n/).map((line) => line.trimStart()
    .replace(/^(?:>[ \t]*)+/, "")
    .replace(/^(?:#{1,6}[ \t]+|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/, ""))
    .join(" ").replace(/\s+/g, " ").trim();
  if (excerpt.length <= MAX_SNIPPET_LENGTH) return excerpt;
  const head = excerpt.slice(0, MAX_SNIPPET_LENGTH - 1).replace(/[\uD800-\uDBFF]$/, "").trimEnd();
  return `${head}…`;
}
