import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const MAX_NOTE_LENGTH = 16_384;
export const PRESENCE_BATCH_SIZE = 64;
const sessionId = z.string().min(1).max(256);
const revision = z.uuid().nullable();
const markdown = z.string().max(MAX_NOTE_LENGTH);
export const noteSchema = z.object({ revision, markdown });
export type Note = z.infer<typeof noteSchema>;
export const readNote = defineRpc({
  name: "zeonest.conversation-notes.read",
  input: z.object({ sessionId }),
  output: noteSchema,
});
const noteUpdate = z.object({ expectedRevision: revision, markdown });
const saveResult = z.object({ status: z.enum(["saved", "conflict"]), note: noteSchema });
export const saveNote = defineRpc({
  name: "zeonest.conversation-notes.save",
  input: noteUpdate.extend({ sessionId }),
  output: saveResult,
});
export const readGlobalNote = defineRpc({
  name: "zeonest.conversation-notes.global-read",
  input: z.object({}),
  output: noteSchema,
});
export const saveGlobalNote = defineRpc({
  name: "zeonest.conversation-notes.global-save",
  input: noteUpdate,
  output: saveResult,
});
export const MAX_SNIPPET_LENGTH = 160;
const summary = z.object({ sessionId, snippet: z.string().max(MAX_SNIPPET_LENGTH), updatedAt: z.number().finite() });
export const noteSummaries = defineRpc({
  name: "zeonest.conversation-notes.summaries",
  input: z.object({ sessionIds: z.array(sessionId).max(PRESENCE_BATCH_SIZE) }),
  output: z.object({ notes: z.array(summary).max(PRESENCE_BATCH_SIZE), unreadable: z.array(sessionId).max(PRESENCE_BATCH_SIZE) }),
});
export type NoteUpdate = z.input<typeof noteUpdate>;
export type NoteSummary = z.output<typeof summary>;
export const notePresence = defineRpc({
  name: "zeonest.conversation-notes.presence",
  input: z.object({ sessionIds: z.array(sessionId).max(PRESENCE_BATCH_SIZE) }),
  output: z.object({ present: z.array(sessionId).max(PRESENCE_BATCH_SIZE) }),
});
export type SaveInput = z.input<typeof saveNote.input>;
export type SaveResult = z.output<typeof saveNote.output>;
