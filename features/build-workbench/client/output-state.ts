import type { Log } from "../shared/contracts";

export type PausedOutput = { offset: number; rows: Log[]; trimmed: boolean };
export type OutputView = { open: boolean; paused?: PausedOutput };

export function isScrollingAway(previous: number, offset: number, distanceFromEnd: number) {
  return offset < previous - 1 && distanceFromEnd > 2;
}

// Reuse the visible prefix while paused. When the bounded buffer discards it,
// keep the reader's window until they explicitly jump to the live tail.
export function pausedRows(previous: Log[], latest: Log[]) {
  const first = previous[0];
  if (!first) return latest;
  const end = previous.at(-1)?.cursor ?? first.cursor;
  if ((latest.at(-1)?.cursor ?? -1) <= end) return previous;
  const start = latest.findIndex((row) => row.cursor === first.cursor);
  if (start < 0) return previous;
  return start === 0 ? latest : latest.slice(start);
}

// RPC rows are transport chunks, not lines. Join same-stream chunks without
// inserting line breaks or treating writes to stderr as failures.
export function outputGroups(rows: Log[]) {
  const groups: Log[] = [];
  let lastCursor: number | undefined;
  for (const row of rows) {
    const group = groups.at(-1);
    if (group?.stream === row.stream && lastCursor !== undefined && row.cursor === lastCursor + 1) group.text += row.text;
    else groups.push({ ...row });
    lastCursor = row.cursor;
  }
  return groups;
}
