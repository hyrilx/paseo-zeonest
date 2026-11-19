import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { codeLines } from "../client/code-lines";
import { Code, panelProps, setCopyText } from "./fixtures/host";
import { button } from "./fixtures/interactions";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("body gutters preserve blank lines, CRLF and trailing newline semantics", () => {
  assert.deepEqual(codeLines("", false), []);
  assert.deepEqual(codeLines("a\r\n\r\nb\r\n", false), [
    { text: "a", kind: "context", next: 1 }, { text: "", kind: "context", next: 2 }, { text: "b", kind: "context", next: 3 },
  ]);
  assert.deepEqual(codeLines("\n", false), [{ text: "", kind: "context", next: 1 }]);
});
test("diff gutters use hunk coordinates and exclude headers/no-newline markers from counts", () => {
  const rows = codeLines("--- a/file\n+++ b/file\n@@ -20,2 +30,3 @@\n first\n-old\n+new\n+extra\n\\ No newline at end of file\n", true);
  assert.deepEqual(rows.map((line) => [line.kind, line.old, line.next]), [
    ["meta", undefined, undefined], ["meta", undefined, undefined], ["hunk", undefined, undefined],
    ["context", 20, 30], ["remove", 21, undefined], ["add", undefined, 31], ["add", undefined, 32], ["meta", undefined, undefined],
  ]);
});
test("multiple hunks, omitted counts and zero-length sides reset coordinates", () => {
  const rows = codeLines("@@ -0,0 +1 @@\n+first\n@@ -15 +16,0 @@\n-gone\n@@ -100 +105 @@\n same\n", true);
  assert.deepEqual(rows.filter((line) => line.kind !== "hunk").map((line) => [line.old, line.next]), [
    [undefined, 1], [15, undefined], [100, 105],
  ]);
});
test("header-like source lines remain additions/removals inside numeric and loose hunks", () => {
  for (const hunk of ["@@ -1 +1 @@", "@@", "@@ function name"]) {
    const rows = codeLines(hunk + "\n--- source text\n+++ source text\n", true);
    assert.equal(rows[1]!.kind, "remove"); assert.equal(rows[2]!.kind, "add");
    assert.equal(rows[1]!.old, hunk === "@@ -1 +1 @@" ? 1 : undefined);
    assert.equal(rows[2]!.next, hunk === "@@ -1 +1 @@" ? 1 : undefined);
  }
});
async function render(text: string, diff = false, compact = false) {
  let root!: ReactTestRenderer;
  await act(async () => { root = create(<Code text={text} diff={diff} colors={panelProps().theme.colors} previewLines={2} compact={compact} />); });
  return root;
}
const rows = (root: ReactTestRenderer) => root.root.findAll((node) => String(node.type) === "View" && String(node.props.testID).startsWith("code-line-"));
test("code preview grows in batches while copy always includes complete original content", async (t) => {
  const text = "one\ntwo\nthree\nfour\nfive\n";
  const root = await render(text, false, true); t.after(async () => { await act(async () => root.unmount()); });
  assert.equal(rows(root).length, 2);
  assert.match(JSON.stringify(root.toJSON()), /正文 · 相对行号/);
  const copy = button(root, "复制完整正文");
  assert.equal(copy.props.style({ pressed: false }).minHeight, 44);
  let copied = ""; setCopyText(async (value) => { copied = value; });
  await act(async () => copy.props.onPress()); assert.equal(copied, text);
  assert.match(JSON.stringify(root.toJSON()), /已复制/);
  await act(async () => button(root, "继续显示").props.onPress()); assert.equal(rows(root).length, 4);
  await act(async () => button(root, "继续显示").props.onPress()); assert.equal(rows(root).length, 5);
  assert.equal(root.root.findAll((node) => String(node.type) === "Pressable" && node.props.accessibilityLabel === "继续显示").length, 0);
  await act(async () => root.update(<Code text="changed" diff={false} colors={panelProps().theme.colors} previewLines={2} compact />));
  assert.ok(!JSON.stringify(root.toJSON()).includes("已复制"));
});
test("diff headers stay out of preview but remain available to copy; copy failure can be retried", async (t) => {
  const text = "Index: file\n===\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n";
  const root = await render(text, true); t.after(async () => { await act(async () => root.unmount()); });
  assert.equal(rows(root).length, 2); assert.ok(!JSON.stringify(root.toJSON()).includes("Index: file"));
  setCopyText(async () => { throw new Error("clipboard denied"); });
  await act(async () => button(root, "复制完整差异").props.onPress());
  assert.match(JSON.stringify(root.toJSON()), /复制失败/);
  let copied = ""; setCopyText(async (value) => { copied = value; });
  await act(async () => button(root, "复制完整差异").props.onPress()); assert.equal(copied, text);
  assert.ok(!JSON.stringify(root.toJSON()).includes("复制失败"));
  assert.match(JSON.stringify(root.toJSON()), /新增 1 行，删除 1 行/);
});
