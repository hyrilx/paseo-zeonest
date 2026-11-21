import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { readGlobalNote, readNote, saveGlobalNote, saveNote, type SaveInput } from "../shared/contracts";
import { defaultPreferences, preferences, preferencesSchema } from "../shared/settings";
import { noteSnippet } from "../shared/snippet";
import { loadCatalog, type NoteActivity } from "./catalog";
import { createNote, createSessionNote, type SessionNote } from "./note";

const readPreferences = settingsRpc(preferences.id).read;

export function createNoteLibrary(client: Pick<PluginClientContext, "paseo" | "rpc">) {
  const notes = new Map<string, SessionNote>();
  const listeners = new Set<() => void>();
  let activity: NoteActivity = { version: 0, drafts: new Map(), saved: new Map() };
  let disposed = false;
  function publish(next: NoteActivity) {
    if (disposed) return;
    activity = next;
    for (const listener of listeners) listener();
  }
  const globalNote = createNote({ read: () => client.rpc(readGlobalNote, {}), save: (input) => client.rpc(saveGlobalNote, input) });
  const transport = {
    read: (sessionId: string) => client.rpc(readNote, { sessionId }),
    async save(input: SaveInput) {
      const result = await client.rpc(saveNote, input);
      if (result.status === "saved") {
        const { sessionId } = input, { markdown } = result.note;
        const version = activity.version + 1;
        const saved = new Map(activity.saved);
        const note = markdown.trim() ? { sessionId, snippet: noteSnippet(markdown), updatedAt: Date.now() } : null;
        saved.set(sessionId, { version, note });
        publish({ ...activity, version, saved });
      }
      return result;
    },
  };

  return {
    globalNote,
    find: (id: string) => notes.get(id),
    get(id: string) {
      const existing = notes.get(id);
      if (existing) return existing;
      const note = createSessionNote(id, transport);
      notes.set(id, note);
      note.subscribe(() => {
        const state = note.get();
        const draft = state.hasDraft ? state.markdown : undefined;
        if (activity.drafts.get(id) === draft) return;
        const drafts = new Map(activity.drafts);
        if (draft === undefined) drafts.delete(id);
        else drafts.set(id, draft);
        publish({ ...activity, drafts });
      });
      return note;
    },
    forgetIdle(id: string) {
      const note = notes.get(id);
      if (note && !note.isOpen() && !note.get().hasDraft) {
        note.dispose();
        notes.delete(id);
      }
    },
    getActivity: () => activity,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    loadCatalog: (signal: AbortSignal) => loadCatalog(client, activity.version, signal),
    async loadPreferences() {
      try {
        const result = await client.rpc(readPreferences, {});
        if (result.status === "ready") return preferencesSchema.parse(result.values);
      } catch {
        // Notes still work if preferences are temporarily unavailable.
      }
      return defaultPreferences;
    },
    dispose() {
      disposed = true;
      globalNote.dispose();
      for (const note of notes.values()) note.dispose();
      notes.clear();
      listeners.clear();
      activity = { version: 0, drafts: new Map(), saved: new Map() };
    },
  };
}

export type NoteLibrary = ReturnType<typeof createNoteLibrary>;
