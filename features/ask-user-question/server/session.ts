import type { PaseoApi } from "@getpaseo/client";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { nativeSummary, parseQuestionnaire, type Questionnaire } from "../shared/questionnaire";

export const MAX_SESSION_BYTES = 32 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const entrySchema = z.object({
  id: z.string(), parentId: z.string().nullable(), type: z.string(),
  message: z.unknown().optional(),
});
const assistantSchema = z.object({
  role: z.literal("assistant"), content: z.array(z.unknown()),
});
const callSchema = z.object({
  type: z.literal("toolCall"), id: z.string(), name: z.literal("ask_user_question"), arguments: z.unknown(),
});
const resultSchema = z.object({
  role: z.literal("toolResult"), toolCallId: z.string(), toolName: z.literal("ask_user_question"),
  details: z.unknown(), isError: z.boolean().optional(),
});
type Request = { agentId: string; callId: string; summary: string };

// Keep only parent links and the requested call/result, not unrelated message bodies.
export function parseSession(text: string, sessionId: string, callId: string, summary: string): Questionnaire | null {
  const lines = text.split("\n");
  const nodes = new Map<string, { parentId: string | null; args?: unknown; result?: unknown }>();
  let header = false;
  let leaf: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    let raw: unknown;
    try { raw = JSON.parse(line); }
    catch {
      // The provider may still be appending the final line.
      if (index === lines.length - 1) break;
      return null;
    }
    if (!header) {
      const parsed = z.object({ type: z.literal("session"), id: z.literal(sessionId) }).safeParse(raw);
      if (!parsed.success) return null;
      header = true;
      continue;
    }
    const parsed = entrySchema.safeParse(raw);
    if (!parsed.success || nodes.has(parsed.data.id)) return null;
    const { id, parentId, message } = parsed.data;
    const node: { parentId: string | null; args?: unknown; result?: unknown } = { parentId };
    const assistant = assistantSchema.safeParse(message);
    if (assistant.success) {
      for (const block of assistant.data.content) {
        const call = callSchema.safeParse(block);
        if (call.success && call.data.id === callId) {
          if (node.args !== undefined) return null;
          node.args = call.data.arguments;
        }
      }
    }
    const result = resultSchema.safeParse(message);
    if (result.success && result.data.toolCallId === callId && !result.data.isError) {
      node.result = { details: result.data.details };
    }
    nodes.set(id, node);
    leaf = id;
  }
  let args: unknown;
  let output: unknown;
  const visited = new Set<string>();
  while (leaf !== null) {
    if (visited.has(leaf)) return null;
    visited.add(leaf);
    const node = nodes.get(leaf);
    if (!node) return null;
    if (node.result !== undefined) {
      if (output !== undefined || args !== undefined) return null;
      output = node.result;
    }
    if (node.args !== undefined) {
      if (args !== undefined || output === undefined) return null;
      args = node.args;
    }
    leaf = node.parentId;
  }
  const data = parseQuestionnaire(args, output);
  if (!data || nativeSummary(data) !== summary || Buffer.byteLength(JSON.stringify(data)) > MAX_PAYLOAD_BYTES) return null;
  return data;
}

export async function readSession(path: string): Promise<string | null> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_SESSION_BYTES) return null;
    // A fixed-size read cannot grow without bound while the provider appends.
    const buffer = Buffer.alloc(stat.size);
    let position = 0;
    while (position < buffer.length) {
      const { bytesRead } = await file.read(buffer, position, buffer.length - position, position);
      if (!bytesRead) break;
      position += bytesRead;
    }
    return buffer.subarray(0, position).toString("utf8");
  } finally { await file.close(); }
}

export async function recover(
  paseo: Pick<PaseoApi, "agents">, input: Request, check: () => void,
  read: (path: string) => Promise<string | null> = readSession,
): Promise<Questionnaire | null> {
  check();
  const handle = paseo.agents.ref(input.agentId);
  const snapshot = await handle.refresh();
  check();
  const persistence = snapshot?.agent.persistence;
  if (persistence?.provider !== "pi" || !persistence.nativeHandle || !isAbsolute(persistence.nativeHandle)
    || !persistence.nativeHandle.endsWith(".jsonl")) return null;
  let text: string | null;
  try { text = await read(persistence.nativeHandle); }
  catch { check(); return null; }
  check();
  if (text === null) return null;
  // Rewinds/reloads may change the native session while the file is being read.
  const current = handle.current()?.persistence;
  if (current?.sessionId !== persistence.sessionId || current.nativeHandle !== persistence.nativeHandle) return null;
  return parseSession(text, persistence.sessionId, input.callId, input.summary);
}
