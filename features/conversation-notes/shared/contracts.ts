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
export const saveNote = defineRpc({
  name: "zeonest.conversation-notes.save",
  input: z.object({ sessionId, expectedRevision: revision, markdown }),
  output: z.object({ status: z.enum(["saved", "conflict"]), note: noteSchema }),
});
export const notePresence = defineRpc({
  name: "zeonest.conversation-notes.presence",
  input: z.object({ sessionIds: z.array(sessionId).max(PRESENCE_BATCH_SIZE) }),
  output: z.object({ present: z.array(sessionId).max(PRESENCE_BATCH_SIZE) }),
});
export type SaveInput = z.input<typeof saveNote.input>;
export type SaveResult = z.output<typeof saveNote.output>;
