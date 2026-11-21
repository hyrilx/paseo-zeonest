import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { MAX_NOTE_LENGTH, noteSchema, noteTimestamps, type Note, type NoteSummary, type NoteUpdate, type SaveInput, type SaveResult } from "../shared/contracts";
import { noteSnippet } from "../shared/snippet";

const MAX_RECORD_BYTES = MAX_NOTE_LENGTH * 6 + 256; // JSON escape sequences take up to six bytes per code unit.
const empty: Note = { revision: null, markdown: "" };
const recordSchema = noteSchema.extend(noteTimestamps.partial().shape);
interface RecordOnDisk { note: Note; timestamps: NonNullable<SaveResult["timestamps"]> }
// One Paseo daemon owns its home. Keep the queue across feature deactivation in this module.
const writes = new Map<string, Promise<unknown>>();
type Guard = () => void;

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function noteDirectory() {
  // Match the daemon's PASEO_HOME resolution, including a literal ~/ in the environment.
  let home = process.env.PASEO_HOME ?? "~/.paseo";
  if (home === "~") home = homedir();
  else if (home.startsWith("~/")) home = join(homedir(), home.slice(2));
  return join(resolve(home), "zeonest", "conversation-notes");
}

export class NoteStore {
  constructor(readonly directory = noteDirectory()) {}

  private path(sessionId: string) {
    return join(this.directory, createHash("sha256").update(sessionId).digest("hex") + ".json");
  }

  private async verifyDirectory() {
    try {
      const directory = await lstat(this.directory);
      if (!directory.isDirectory()) throw new Error("会话笔记目录无效");
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }

  private async readRecord(path: string): Promise<RecordOnDisk | null> {
    let file;
    try {
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw new Error("会话笔记记录无效");
      const { createdAt, updatedAt, ...note } = recordSchema.parse(JSON.parse(await file.readFile("utf8")));
      if (note.revision === null) throw new Error("会话笔记缺少版本");
      // Previous versions kept neither date. Use the last recorded write until the next save stamps it.
      return { note, timestamps: { createdAt: createdAt ?? stat.mtimeMs, updatedAt: updatedAt ?? stat.mtimeMs } };
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    } finally {
      await file?.close();
    }
  }

  private async record(path: string, guard: Guard): Promise<RecordOnDisk | null> {
    guard();
    const exists = await this.verifyDirectory();
    guard();
    const result = exists ? await this.readRecord(path) : null;
    guard();
    return result;
  }

  async read(sessionId: string, guard: Guard): Promise<Note> {
    return (await this.record(this.path(sessionId), guard))?.note ?? empty;
  }

  async readGlobal(guard: Guard): Promise<Note> {
    return (await this.record(join(this.directory, "global.json"), guard))?.note ?? empty;
  }

  async summaries(sessionIds: readonly string[], guard: Guard) {
    guard();
    const notes: NoteSummary[] = [], unreadable: string[] = [];
    if (await this.verifyDirectory()) {
      const entries = await Promise.all([...new Set(sessionIds)].map(async (sessionId) => {
        guard();
        try {
          const record = await this.readRecord(this.path(sessionId));
          return { sessionId, record };
        } catch { return { sessionId, error: true } as const; }
      }));
      for (const entry of entries) {
        if (entry.error) unreadable.push(entry.sessionId);
        else if (entry.record?.note.markdown.trim()) {
          const { note, timestamps } = entry.record;
          notes.push({ sessionId: entry.sessionId, snippet: noteSnippet(note.markdown), ...timestamps });
        }
      }
    }
    guard();
    return { notes, unreadable };
  }

  async presence(sessionIds: readonly string[], guard: Guard): Promise<string[]> {
    const present = await Promise.all(sessionIds.map(async (id) => {
      try { return (await this.read(id, guard)).markdown.trim() ? id : null; }
      catch { return null; } // One unreadable note must not hide other notes. Opening it reports the error.
    }));
    guard();
    return present.filter((id): id is string => id !== null);
  }

  save(input: SaveInput, guard: Guard): Promise<SaveResult> {
    return this.saveNote(this.path(input.sessionId), input, guard);
  }

  saveGlobal(input: NoteUpdate, guard: Guard): Promise<SaveResult> {
    return this.saveNote(join(this.directory, "global.json"), input, guard);
  }

  private saveNote(path: string, input: NoteUpdate, guard: Guard): Promise<SaveResult> {
    guard();
    const job = (writes.get(path) ?? Promise.resolve()).catch(() => {}).then(async (): Promise<SaveResult> => {
      const record = await this.record(path, guard);
      const current = record?.note ?? empty;
      if (current.markdown === input.markdown) return { status: "saved", note: current, timestamps: record?.timestamps };
      if (current.revision !== input.expectedRevision) return { status: "conflict", note: current };
      const note = noteSchema.parse({ revision: randomUUID(), markdown: input.markdown });
      const updatedAt = Math.max(Date.now(), record?.timestamps.updatedAt ?? 0);
      const timestamps = { createdAt: record?.timestamps.createdAt ?? updatedAt, updatedAt };
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (!await this.verifyDirectory()) throw new Error("会话笔记目录不存在");
      guard();
      const temporary = join(this.directory, ".note-" + randomUUID());
      const file = await open(temporary, "wx", 0o600);
      try {
        try {
          await file.writeFile(JSON.stringify({ ...note, ...timestamps }));
          await file.sync();
        } finally {
          await file.close();
        }
        guard();
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch(() => {});
      }
      guard();
      return { status: "saved", note, timestamps };
    });
    writes.set(path, job);
    const release = () => { if (writes.get(path) === job) writes.delete(path); };
    void job.then(release, release);
    return job;
  }
}
