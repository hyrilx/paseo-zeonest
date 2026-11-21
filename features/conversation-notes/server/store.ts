import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { MAX_NOTE_LENGTH, noteSchema, type Note, type SaveInput, type SaveResult } from "../shared/contracts";

const MAX_RECORD_BYTES = MAX_NOTE_LENGTH * 6 + 256; // JSON escape sequences take up to six bytes per code unit.
const empty: Note = { revision: null, markdown: "" };
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

  private async readPath(path: string): Promise<Note> {
    let file;
    try {
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw new Error("会话笔记记录无效");
      const note = noteSchema.parse(JSON.parse(await file.readFile("utf8")));
      if (note.revision === null) throw new Error("会话笔记缺少版本");
      return note;
    } catch (error) {
      if (missing(error)) return empty;
      throw error;
    } finally {
      await file?.close();
    }
  }

  async read(sessionId: string, guard: Guard): Promise<Note> {
    guard();
    const exists = await this.verifyDirectory();
    guard();
    const note = exists ? await this.readPath(this.path(sessionId)) : empty;
    guard();
    return note;
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
    guard();
    const path = this.path(input.sessionId);
    const job = (writes.get(path) ?? Promise.resolve()).catch(() => {}).then(async (): Promise<SaveResult> => {
      const current = await this.read(input.sessionId, guard);
      if (current.markdown === input.markdown) return { status: "saved", note: current };
      if (current.revision !== input.expectedRevision) return { status: "conflict", note: current };
      const note = noteSchema.parse({ revision: randomUUID(), markdown: input.markdown });
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (!await this.verifyDirectory()) throw new Error("会话笔记目录不存在");
      guard();
      const temporary = join(this.directory, ".note-" + randomUUID());
      const file = await open(temporary, "wx", 0o600);
      try {
        try {
          await file.writeFile(JSON.stringify(note));
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
      return { status: "saved", note };
    });
    writes.set(path, job);
    const release = () => { if (writes.get(path) === job) writes.delete(path); };
    void job.then(release, release);
    return job;
  }
}
