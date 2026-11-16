import assert from "node:assert/strict";
import test from "node:test";
import { historyTransformer } from "../client/transform";

type TransformerItem = Parameters<typeof historyTransformer.transform>[0]["item"];

const history = "Source agent: Example\n[User] Previous question\n[Assistant] Previous answer";
const summary = `<chat-history-summary>\n${history}\n</chat-history-summary>`;

// Model only the v0.15.4 host's user-message projection, not a plugin adapter.
// The host keeps live attachments outside text and does not forward them here:
// https://github.com/getpaseo/paseo/blob/v0.15.4/packages/app/src/plugins/timeline/projection.ts#L44-L53
// This is an input-contract reproduction; it does not execute the Paseo host.
function sourceUserMessage(
  item: Pick<TransformerItem, "text" | "messageId" | "clientMessageId">,
): TransformerItem {
  return {
    type: "user_message",
    text: item.text,
    ...(item.messageId ? { messageId: item.messageId } : {}),
    ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}),
  };
}

test("v0.15.4 live chat-history attachments remain native when omitted from transformer input", () => {
  for (const body of ["Continue here", ""]) {
    const submitted = Object.freeze({
      text: body,
      clientMessageId: "local-message",
      attachments: Object.freeze([
        Object.freeze({ type: "text", contextKind: "chat_history", text: summary }),
      ]),
    });
    const live = Object.freeze(sourceUserMessage(submitted));
    // Canonical acknowledgement adds identity but keeps the local presentation:
    // https://github.com/getpaseo/paseo/blob/v0.15.4/packages/app/src/types/stream.ts#L261-L268
    const acknowledged = Object.freeze(sourceUserMessage({ ...submitted, messageId: "server-message" }));

    for (const item of [live, acknowledged]) {
      assert.equal(item.text, body);
      assert.equal(Object.hasOwn(item, "attachments"), false);
      for (const phase of ["streaming", "complete"] as const) {
        assert.equal(historyTransformer.transform({ item, phase }), undefined);
      }
    }
    assert.equal(submitted.attachments[0]!.text, summary);
    assert.equal(submitted.text, body);
  }
});

test("history is recognized once reloaded message text contains the summary tags", () => {
  for (const body of ["Continue here", ""]) {
    const item = Object.freeze(sourceUserMessage({
      text: `${summary}\n\n${body}`,
      messageId: "server-message",
      clientMessageId: "local-message",
    }));
    const result = historyTransformer.transform({ item, phase: "complete" })!;
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]!.kind, "chat-history");
    assert.deepEqual(result.items[0]!.data, { histories: [`\n${history}\n`], body: `\n\n${body}` });
  }
});
