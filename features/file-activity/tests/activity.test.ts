import assert from "node:assert/strict";
import test from "node:test";
import { kinds, mergeRecords, projectActivity, selectActivities } from "../client/activity";
import { record, tool, unknown, user } from "./fixtures/timeline";

test("native reads retain requested ranges, edits are fragment diffs, ambiguous writes are not called creates", () => {
  const projection = projectActivity([user(1, "t1"), record(tool("r", { type: "read", filePath: "/a", offset: 20, limit: 5, content: "lines" }), 2, "t1"),
    record(tool("e", { type: "edit", filePath: "/a", oldString: "old\n", newString: "new\n" }), 3, "t1"),
    user(4, "t2", "继续"), record(tool("w", { type: "write", filePath: "/b", content: "" }), 5, "t2")]);
  assert.equal(projection.turns.length, 2);
  assert.match(projection.activities[0]!.range!, /20.*5/);
  assert.equal(projection.activities[0]!.content, "lines");
  assert.match(projection.activities[1]!.diff!, /-old\n\+new/);
  assert.match(projection.activities[1]!.note!, /片段/);
  assert.equal(projection.activities[2]!.kind, "edit");
  assert.equal(projection.activities[2]!.content, "");
  assert.match(projection.activities[2]!.note!, /未说明/);
});
test("apply_patch expands multi-file create/edit/delete and move without filesystem reads", () => {
  const patch = "*** Begin Patch\n*** Add File: new file.txt\n+hello\n+world\n*** Update File: old.txt\n*** Move to: moved.txt\n@@\n-old\n+new\n*** Delete File: gone.txt\n*** End Patch";
  const projection = projectActivity([user(0), record(unknown("patch", "functions.apply_patch", { patch }), 1)]);
  assert.deepEqual(projection.activities.map((activity) => [activity.kind, activity.path]), [["create", "new file.txt"], ["edit", "old.txt"], ["delete", "gone.txt"]]);
  assert.equal(projection.activities[0]!.content, "hello\nworld\n");
  assert.match(projection.activities[1]!.diff!, /-old/);
  assert.match(projection.activities[1]!.note!, /moved.txt/);
  assert.equal(projection.activities[2]!.content, undefined);
});
test("unified patches identify dev/null adds/deletes and preserve no-newline markers", () => {
  const diff = "--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+x\n\\ No newline at end of file\n--- a/b.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n";
  const activities = projectActivity([record(tool("p", { type: "edit", filePath: "ignored", unifiedDiff: diff }), 1)]).activities;
  assert.deepEqual(activities.map((activity) => activity.kind), ["create", "delete"]);
  assert.equal(activities[0]!.content, "x");
  assert.equal(activities[1]!.path, "b.txt");
  assert.match(activities[1]!.diff!, /-old/);
});
test("Pi-style unknown tools support edits arrays, explicit create/delete, and read output", () => {
  const activities = projectActivity([
    record(unknown("e", "functions.edit", { path: "x", edits: [{ oldText: "a", newText: "b" }, { oldText: "b", newText: "c" }] }), 1),
    record(unknown("r", "read_file", { file_path: "x", start_line: 0, end_line: 3 }, { content: [{ type: "text", text: "abc" }] }), 2),
    record(unknown("c", "create_file", { path: "empty", content: "" }), 3),
    record(unknown("d", "delete_file", { path: "gone" }), 4),
  ]).activities;
  assert.equal(activities.length, 5);
  assert.match(activities[0]!.diff!, /-a/);
  assert.match(activities[1]!.diff!, /\+c/);
  assert.match(activities[2]!.range!, /0–3/);
  assert.equal(activities[2]!.content, "abc");
  assert.equal(activities[3]!.content, "");
  assert.equal(activities[4]!.kind, "delete");
});
test("local search emits one activity per returned path; web/shell and unknown commands are not guessed", () => {
  const activities = projectActivity([
    record(tool("s", { type: "search", query: "symbol", filePaths: ["a", "b", "a"] }), 1),
    record(tool("web", { type: "search", query: "url", toolName: "web_search", filePaths: ["https://a"] }), 2),
    record(tool("bash", { type: "shell", command: "rm a; cat b", exitCode: 0 }), 3),
    record(unknown("x", "unrecognized", { path: "a", content: "x" }), 4),
    record(tool("remote", { type: "read", filePath: "https://a" }), 5),
  ]).activities;
  assert.deepEqual(activities.map((item) => item.path), ["a", "b"]);
  assert.match(activities[0]!.range!, /symbol/);
});
test("tool lifecycle deduplicates callId, keeps first order/turn and missing detail from running item", () => {
  const entries = [
    user(1, "first"), record(tool("r", { type: "read", filePath: "x", offset: 10 }, "running"), 2, "first"),
    user(3, "second"), record(tool("r", { type: "read", filePath: "x", content: "done" }), 4),
  ];
  const merged = mergeRecords(entries);
  assert.equal(merged.length, 3);
  assert.equal(merged[1]!.updatedSeq, 4);
  const projection = projectActivity(entries);
  assert.equal(projection.activities.length, 1);
  assert.equal(projection.activities[0]!.turnId, "first");
  assert.equal(projection.activities[0]!.status, "completed");
  assert.match(projection.activities[0]!.range!, /10/);
});
test("all/turn/category/status filters and every ordering are deterministic", () => {
  const projection = projectActivity([
    user(0, "a"), record(unknown("c", "create_file", { path: "z", content: "x" }), 1, "a"),
    record(tool("r", { type: "read", filePath: "a" }, "failed"), 2, "a"),
    user(3, "b"), record(unknown("d", "delete_file", { path: "m" }), 4, "b"),
  ]);
  const all = kinds.map((kind) => kind.value);
  assert.deepEqual(selectActivities(projection, null, all, "time", false, true).map((item) => item.callId), ["c", "r", "d"]);
  assert.deepEqual(selectActivities(projection, null, all, "time", true, true).map((item) => item.callId), ["d", "r", "c"]);
  assert.deepEqual(selectActivities(projection, null, all, "path", false, true).map((item) => item.path), ["a", "m", "z"]);
  assert.deepEqual(selectActivities(projection, null, all, "kind", false, true).map((item) => item.kind), ["create", "delete", "read"]);
  assert.equal(selectActivities(projection, "a", all, "time", false, false).length, 1);
  assert.equal(selectActivities(projection, null, ["read"], "time", false, true).length, 1);
  assert.equal(selectActivities(projection, null, [], "time", false, true).length, 0);
});
test("missing ranges, malformed patches, huge snippets and absent turn IDs are explicit", () => {
  const projection = projectActivity([
    record(tool("r", { type: "read", filePath: "x" }), 1),
    record(tool("e", { type: "edit", filePath: "x", oldString: "x".repeat(400001), newString: "y" }), 2),
    record(tool("p", { type: "edit", filePath: "x", unifiedDiff: "not a diff" }), 3),
    user(4), record(unknown("d", "delete_file", { path: "z" }), 5),
  ]);
  assert.equal(projection.turns[0]!.title, "未归属轮次");
  assert.match(projection.activities[0]!.range!, /未记录/);
  assert.equal(projection.activities[1]!.diff, undefined);
  assert.equal(projection.activities[2]!.diff, "not a diff");
  assert.equal(projection.activities[3]!.turnId, projection.turns[1]!.id);
});
