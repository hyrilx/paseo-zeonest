import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { addedTargets, defaultTool, limitDock, ProbeCompletions } from "../client/workbench-state";
import { targetId, type Candidate, type Run, type Target } from "../shared/contracts";

const tool: Candidate = { id: "one", label: "Tool", requirement: "fixture", paths: [] };
const target = (name: string, project = ".", adapter: Target["adapter"] = "cmake"): Target =>
  ({ project, adapter, name, source: "test", outputs: [] });
function run(operation?: Run["operation"], status: Run["status"] = "queued"): Run {
  const t = target("configure");
  return { id: randomUUID(), sequence: 1, operation, status, createdAt: 0, fingerprint: "",
    configuration: { target: t, tool: tool.id, options: [], artifacts: [] }, command: { argv: [], cwd: ".", source: t.source, tool } };
}

test("refresh only for successful probes observed live or submitted in the current workspace", () => {
  const observed = new ProbeCompletions();
  const historical = run("probe", "success");
  const submitted = run("probe");
  const failed = run("probe", "running");
  const ordinary = run(undefined, "running");
  const live = run("probe", "running");
  observed.watch(submitted);
  assert.deepEqual(observed.observe([historical, failed, ordinary, live]), []);
  const updates = [{ ...failed, status: "failed" }, { ...ordinary, status: "success" },
    { ...submitted, status: "success" }, { ...live, status: "success" }, historical] as Run[];
  assert.deepEqual(observed.observe(updates).map(({ id }) => id), [submitted.id, live.id]);
  assert.deepEqual(observed.observe(updates), []);
  assert.deepEqual(new ProbeCompletions().observe(updates), []);
});

test("new targets exclude unrelated additions, previous targets and probes", () => {
  const old = target("old");
  const next = target("example");
  const otherProject = target("other", "sub");
  const otherAdapter = target("bin", ".", "cargo");
  assert.deepEqual(addedTargets([old], [old, next, otherProject, otherAdapter, { ...target("probe"), operation: "probe" }], [run("probe", "success")]), [targetId(next)]);
  assert.deepEqual(addedTargets([old], [old], [run("probe", "success")]), []);
});

test("prefer an installed compatible candidate without replacing any saved choice", () => {
  const bad = { ...tool, id: "java8", gradleRuntime: { status: "incompatible", reason: "" } } as const;
  const maybe = { ...tool, id: "unsure", gradleRuntime: { status: "unknown", reason: "" } } as const;
  const ok = { ...tool, id: "java17", gradleRuntime: { status: "compatible", reason: "" } } as const;
  assert.equal(defaultTool([bad, maybe, ok]), "java17");
  assert.equal(defaultTool([bad, maybe]), "unsure");
  assert.equal(defaultTool([bad]), "");
  assert.equal(defaultTool([bad, ok], "java8"), "java8");
  assert.equal(defaultTool([ok], "missing"), "missing");
  assert.equal(defaultTool([tool]), "one");
  assert.equal(limitDock(120, 145, 400), 145);
  assert.equal(limitDock(530, 145, 400), 400);
});
