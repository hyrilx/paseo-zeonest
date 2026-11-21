import assert from "node:assert/strict";
import test from "node:test";
import { formatMarkdown, taskMarkers, toggleTaskMarker } from "../client/markdown";
import { previewMarkdown } from "../client/preview";

test("inline shortcuts wrap selected Chinese text and keep the selection for reversal", () => {
  const bold = formatMarkdown("🙂笔记结论", { start: 2, end: 4 }, "bold");
  assert.deepEqual(bold, { markdown: "🙂**笔记**结论", selection: { start: 4, end: 6 } });
  assert.equal(formatMarkdown(bold.markdown, bold.selection, "bold").markdown, "🙂笔记结论");
  const strike = formatMarkdown("前后", { start: 1, end: 1 }, "strike");
  assert.deepEqual(strike, { markdown: "前~~~~后", selection: { start: 3, end: 3 } });
  assert.equal(formatMarkdown("~~过时~~", { start: 0, end: 6 }, "strike").markdown, "过时");
});

test("line shortcuts act on the current line or selected lines and preserve separators and indentation", () => {
  assert.deepEqual(formatMarkdown("首行\r\n下行", { start: 1, end: 1 }, "heading"), {
    markdown: "## 首行\r\n下行", selection: { start: 4, end: 4 },
  });
  const bullet = formatMarkdown("  第一\r\n\r\n  第二\r\n别动", { start: 0, end: 14 }, "bullet");
  assert.equal(bullet.markdown, "  - 第一\r\n\r\n  - 第二\r\n别动");
  assert.equal(formatMarkdown(bullet.markdown, bullet.selection, "checklist").markdown, "  - [ ] 第一\r\n\r\n  - [ ] 第二\r\n别动");
  assert.equal(formatMarkdown("9. item", { start: 5, end: 5 }, "bullet").markdown, "- item");
  assert.deepEqual(formatMarkdown("", { start: 0, end: 0 }, "checklist"), {
    markdown: "- [ ] ", selection: { start: 6, end: 6 },
  });
});

test("task toggle edits only the marker character and ignores non-tasks in code or escaped text", () => {
  const source = "- [ ] one\r\n  continued\r\n- [X] two\r\n\r\n```md\r\n- [ ] code\r\n```\r\n\r\n\\- [ ] not a task\r\n";
  const markers = taskMarkers(source);
  assert.deepEqual(markers.map(({ checked }) => checked), [false, true]);
  assert.equal(toggleTaskMarker(source, markers[1]!), source.replace("[X]", "[ ]"));
  assert.equal(toggleTaskMarker(source.replace("[X]", "[ ]"), markers[1]!), source.replace("[X]", "[ ]"));
  const continued = source.indexOf("continued");
  assert.equal(formatMarkdown(source, { start: continued, end: continued }, "toggle-task").markdown, source.replace("[ ] one", "[x] one"));
  const all = formatMarkdown(source, { start: 0, end: source.length }, "toggle-task");
  assert.equal(all.markdown, source.replace("[ ] one", "[x] one").replace("[X] two", "[x] two"));
  assert.deepEqual(all.selection, { start: 0, end: source.length });
});

test("preview uses host Markdown except for task containers and preserves nested task offsets", () => {
  const prefix = "# 标题\n\n**粗体** ~~划掉~~ `代码` [链接](https://example.com)\n\n```md\n- [ ] code\n```\n";
  assert.deepEqual(previewMarkdown(prefix), [{ kind: "markdown", markdown: prefix }]);
  const source = prefix + "\n- [ ] 第一\n  继续\n  - [x] 嵌套\n- 普通项\n\n> 旁注\n>\n> 4. [ ] 引用待办\n>    继续\n> 5. 其他\n\n尾声";
  const [start, list, quote, tail] = previewMarkdown(source);
  assert.deepEqual(start, { kind: "markdown", markdown: prefix + "\n" });
  assert.equal(list?.kind, "list");
  assert.deepEqual(list.items.map(({ bullet, task }) => [bullet, task?.label]), [["•", "第一"], ["•", undefined]]);
  assert.equal(list.items[0]?.content[0]?.kind, "markdown");
  assert.equal(list.items[0]?.content[0]?.markdown.trim(), "第一\n继续");
  const nested = list.items[0]?.content[1];
  assert.equal(nested?.kind, "list");
  assert.equal(nested.items[0]?.task?.checked, true);
  assert.equal(quote?.kind, "quote");
  const quotedList = quote.content[1];
  assert.equal(quotedList?.kind, "list");
  assert.deepEqual(quotedList.items.map(({ bullet }) => bullet), ["4.", "5."]);
  const task = quotedList.items[0]?.task;
  assert.ok(task);
  assert.equal(toggleTaskMarker(source, task), source.replace("[ ] 引用待办", "[x] 引用待办"));
  assert.deepEqual(tail, { kind: "markdown", markdown: "\n\n尾声" });
});

test("reference links still have definitions in a task fragment", () => {
  const source = "- [ ] [链接][site]\n\n[site]: https://example.com\n";
  const [list] = previewMarkdown(source);
  assert.equal(list?.kind, "list");
  assert.deepEqual(list.items[0]?.content, [{ kind: "markdown", markdown: "[site]: https://example.com\n\n[链接][site]" }]);
});

test("deeply nested Markdown previews as text instead of crashing", () => {
  const markdown = "> ".repeat(7500) + "- [ ] item";
  assert.deepEqual(previewMarkdown(markdown), [{ kind: "text", markdown }]);
});
