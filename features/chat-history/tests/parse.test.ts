import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseHistory, splitHistoryMessage } from "../client/parse";
import { chatHistorySchema, historyTransformer } from "../client/transform";

const fixture = readFileSync(new URL("./fixtures/fork-message.txt", import.meta.url), "utf8");
const wrap = (text: string) => `<chat-history-summary>${text}</chat-history-summary>`;

test("extracts a v0.15.4-style fork summary, preserving current body and entry order", () => {
  const result = splitHistoryMessage(fixture)!;
  assert.equal(result.histories.length, 1);
  assert.equal(result.body, "\n\n继续处理错误提示。\n");
  const parsed = parseHistory(result.histories[0]!);
  assert.equal(parsed.source, "Example refactor");
  assert.deepEqual(parsed.entries.map(({ role, label }) => [role, label]), [
    ["meta", "Meta"], ["user", "User"], ["action", "Read"], ["assistant", "Assistant"], ["action", "Run"], ["assistant", "Assistant"],
  ]);
  assert.match(parsed.entries[0]!.text, /Source directory: \/workspace\/example/);
  assert.equal(parsed.entries[1]!.text, "请检查配置读取逻辑。\n第二行需求。");
  assert.match(parsed.entries[3]!.text, /```ts\nconst ready = true;\n```/);
  assert.equal(parsed.omitted, false);
});

test("supports multiple, empty, inline, and nested wrappers without swallowing current text", () => {
  assert.deepEqual(splitHistoryMessage(`before\n${wrap("[User] first")}\nbetween\n${wrap("[Assistant] second")}\nafter`), {
    histories: ["[User] first", "[Assistant] second"], body: "before\n\nbetween\n\nafter",
  });
  assert.deepEqual(splitHistoryMessage(wrap("")), { histories: [""], body: "" });
  const nested = `[User] ${wrap("[User] older\n[Assistant] old reply")}\nnew question\n[Assistant] latest reply`;
  assert.deepEqual(splitHistoryMessage(`${wrap(nested)}\ncurrent`), { histories: [nested], body: "\ncurrent" });
  const parsed = parseHistory(nested);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0]!.text, `${wrap("[User] older\n[Assistant] old reply")}\nnew question`);
  assert.equal(parsed.entries[1]!.text, "latest reply");
});

test("leaves ordinary, escaped, incomplete, stray, and code-example tags in native messages", () => {
  for (const text of [
    "Chat history", "plain message", "<chat-history-summary>missing end", "</chat-history-summary>",
    `${wrap("valid")}\n<chat-history-summary>partial`, `${wrap("valid")}</chat-history-summary>`,
    `\\<chat-history-summary>literal\\</chat-history-summary>`,
    `\`${wrap("inline example")}\``, `\`\`\`xml\n${wrap("example")}\n\`\`\``,
    `~~~~xml\n${wrap("example")}\n~~~~`,
  ]) assert.equal(splitHistoryMessage(text), null, text);
});

test("ignores fake closing tags and role markers in fenced and inline code", () => {
  const summary = "[Assistant] ```xml\n[User] ```\n</chat-history-summary>\n[User] literal\n```\nStill assistant.\n[Read] config.json";
  const result = splitHistoryMessage(`${wrap(summary)}\nContinue`)!;
  assert.equal(result.histories[0], summary);
  const parsed = parseHistory(summary);
  assert.deepEqual(parsed.entries.map((entry) => entry.role), ["assistant", "action"]);
  assert.match(parsed.entries[0]!.text, /\[User\] literal/);
  assert.equal(splitHistoryMessage(wrap("[Assistant] Use `</chat-history-summary>` literally."))!.histories[0], "[Assistant] Use `</chat-history-summary>` literally.");
});

test("preserves unknown content, tool names, markdown links, and source truncation markers", () => {
  const parsed = parseHistory("metadata\n[Earlier chat history omitted]\n[User] long beginning\n[Message truncated]\nlong ending\n[Vendor / custom tool] summary\n[Tasks]\n- [x] done\n[Assistant] [docs](https://example.test)\n[reference](https://example.test)\n[Thought] note");
  assert.equal(parsed.omitted, true);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.entries[1]!.text, "long beginning\n[Message truncated]\nlong ending");
  assert.equal(parsed.entries[2]!.role, "action");
  assert.equal(parsed.entries[2]!.label, "Vendor / custom tool");
  assert.equal(parsed.entries[3]!.text, "- [x] done");
  assert.match(parsed.entries[4]!.text, /\[reference\]\(https:/);
  assert.equal(parsed.entries[5]!.role, "meta");
  assert.deepEqual(parseHistory("unstructured history").entries, [{ role: "meta", label: "Meta", text: "unstructured history" }]);
  assert.deepEqual(parseHistory("\n\n").entries, []);
});

test("supports CRLF and a large summary without a plugin-side truncation", () => {
  const text = fixture.replaceAll("\n", "\r\n");
  assert.equal(splitHistoryMessage(text)!.body, "\r\n\r\n继续处理错误提示。\r\n");
  const body = "[Assistant] " + "多行消息\n".repeat(20_000) + "保留末尾";
  assert.equal(splitHistoryMessage(wrap(body))!.histories[0], body);
  assert.ok(parseHistory(body).entries[0]!.text.endsWith("保留末尾"));
});

test("transformer is deterministic, non-mutating, JSON-safe, and leaves unrecognized rows alone", () => {
  assert.equal(historyTransformer.query.itemType, "user_message");
  const input = Object.freeze({ type: "user_message" as const, text: fixture, messageId: "m", clientMessageId: "c" });
  const a = historyTransformer.transform({ item: input, phase: "complete" })!;
  assert.deepEqual(historyTransformer.transform({ item: input, phase: "complete" }), a);
  assert.equal(a.items.length, 1);
  assert.equal(a.items[0]!.kind, "chat-history");
  assert.equal(a.items[0]!.version, 1);
  assert.deepEqual(chatHistorySchema.parse(JSON.parse(JSON.stringify(a.items[0]!.data))), splitHistoryMessage(fixture));
  assert.equal(historyTransformer.transform({ item: { type: "user_message", text: "No history" }, phase: "complete" }), undefined);
  assert.equal(chatHistorySchema.safeParse({ histories: [], body: "" }).success, false);
  assert.equal(chatHistorySchema.safeParse({ histories: [42], body: "" }).success, false);
});
