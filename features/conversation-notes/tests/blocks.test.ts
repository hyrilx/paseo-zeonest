import assert from "node:assert/strict";
import test from "node:test";
import { editBlock, emptyBlock, parseMarkdown, toMarkdown } from "../client/blocks";

test("typed markers restyle blocks, including a task typed after the bullet marker disappears", () => {
  assert.deepEqual(editBlock(emptyBlock(), "# ").blocks, [{ kind: "heading", text: "" }]);
  const [bullet] = editBlock(emptyBlock(), "- ").blocks;
  assert.deepEqual(bullet, { kind: "bullet", text: "" });
  assert.deepEqual(editBlock(bullet!, "[ ]").blocks, [{ kind: "bullet", text: "[ ]" }]);
  assert.deepEqual(editBlock(bullet!, "[ ] ").blocks, [{ kind: "task", text: "", checked: false }]);
  assert.deepEqual(editBlock(emptyBlock(), "- [ ] 待办").blocks, [{ kind: "task", text: "待办", checked: false }]);
});

test("splitting a checked task continues with an unchecked task and places the caret before the suffix", () => {
  const [task] = parseMarkdown("- [x] 前后");
  const result = editBlock(task!, "前\n后");
  assert.equal(toMarkdown(result.blocks), "- [x] 前\n- [ ] 后");
  assert.deepEqual(result.focus, { index: 1, offset: 0 });
});

test("Markdown preserves task state, blank lines and plain inline syntax on reopening", () => {
  const markdown = "# 结论\n\n- 一项 **粗体** `代码`\n- [ ] 查资料\n- [x] [链接](https://example.com)\n";
  const blocks = parseMarkdown(markdown);
  assert.equal(toMarkdown(blocks), markdown);
  assert.deepEqual(blocks.slice(3, 5), [
    { kind: "task", text: "查资料", checked: false },
    { kind: "task", text: "[链接](https://example.com)", checked: true },
  ]);
});
