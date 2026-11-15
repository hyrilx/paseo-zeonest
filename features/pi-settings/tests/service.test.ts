import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PiSettingsService, type Runner } from "../server/service";
import { parseObject } from "../shared/config";
import { atomicWrite } from "../server/files";
import type { DocumentKind, Snapshot } from "../shared/contracts";

function fixture(t: { after(fn: () => void): void }, runner?: Runner, now?: () => number, writeFile?: typeof atomicWrite) {
  const root = mkdtempSync(join(tmpdir(), "zeonest-pi-test-"));
  const agent = join(root, "agent"); const project = join(root, "project"); mkdirSync(agent); mkdirSync(project);
  const service = new PiSettingsService({ home: root, agentDir: agent, runner, now, writeFile,
    workspaceDirectory: async (id) => { if (id !== "project") throw new Error("unknown workspace"); return project; } });
  t.after(() => { service.dispose(); rmSync(root, { recursive: true, force: true }); });
  const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  return { root, agent, project, service, put };
}
function doc(snapshot: Snapshot, kind: DocumentKind) { return snapshot.documents.find((d) => d.kind === kind)!; }

test("preview does not write; confirm gate, exact bytes and token single-use", async (t) => {
  const { service, agent } = fixture(t); const state = await service.snapshot({});
  const text = '{\n  // keep comments\n  "defaultModel": "new-model",\n}\n';
  const plan = await service.prepare({}, [{ kind: "settings", text, revision: doc(state, "settings").revision }]);
  assert.equal(existsSync(join(agent, "settings.json")), false);
  assert.match(plan.changes[0]!.diff, /\+.*new-model/);
  await assert.rejects(service.commit(plan.token, false), /确认 diff/);
  await service.commit(plan.token, true); assert.equal(readFileSync(join(agent, "settings.json"), "utf8"), text);
  await assert.rejects(service.commit(plan.token, true), /过期|取消/);
});

test("cancel and expiry never modify files", async (t) => {
  let time = 1000; const { service, agent } = fixture(t, undefined, () => time);
  const a = await service.prepare({}, [{ kind: "settings", text: '{"defaultProvider":"a"}', revision: "missing" }]);
  assert.equal(service.discard(a.token), true);
  await assert.rejects(service.commit(a.token, true));
  const b = await service.prepare({}, [{ kind: "settings", text: '{"defaultProvider":"b"}', revision: "missing" }]);
  time += 1_200_001; await assert.rejects(service.commit(b.token, true));
  assert.equal(existsSync(join(agent, "settings.json")), false);
});

test("stale snapshots and preview conflicts cannot overwrite concurrent edits", async (t) => {
  const { service, agent, put } = fixture(t); const path = join(agent, "settings.json"); put(path, '{"unknown":1}');
  const before = doc(await service.snapshot({}), "settings");
  const plan = await service.prepare({}, [{ kind: "settings", text: '{"unknown":1,"defaultModel":"a"}', revision: before.revision }]);
  put(path, '{"unknown":2}');
  await assert.rejects(service.commit(plan.token, true), /其他客户端/);
  await assert.rejects(service.prepare({}, [{ kind: "settings", text: "{}", revision: before.revision }]), /其他客户端/);
  assert.equal(readFileSync(path, "utf8"), '{"unknown":2}');
});

test("confirmation preference itself requires the OLD gate and directory changes invalidate plans", async (t) => {
  const { service, agent } = fixture(t); const snapshot = await service.snapshot({});
  const plan = await service.prepare({}, [{ kind: "preferences", text: '{"confirmDiff":false}', revision: "missing" }]);
  assert.equal(plan.confirmationRequired, true); await assert.rejects(service.commit(plan.token, false)); await service.commit(plan.token, true);
  const next = await service.prepare({}, [{ kind: "settings", text: '{"defaultModel":"x"}', revision: doc(snapshot, "settings").revision }]);
  assert.equal(next.confirmationRequired, false); await service.commit(next.token, false);
  assert.equal(parseObject(readFileSync(join(agent, "settings.json"), "utf8")).defaultModel, "x");
});

test("project settings and MCP are isolated; models stay global", async (t) => {
  const { service, agent, project, put } = fixture(t);
  put(join(agent, "settings.json"), '{"defaultModel":"inherited","custom":{"a":1}}');
  put(join(agent, "models.json"), '{"providers":{"local":{"models":[{"id":"one"}]}}}');
  const snapshot = await service.snapshot({ workspaceId: "project" });
  assert.equal(doc(snapshot, "models").path, join(agent, "models.json"));
  assert.equal(parseObject(snapshot.globalSettings).defaultModel, "inherited");
  const plan = await service.prepare({ workspaceId: "project" }, [{ kind: "mcp", text: '{"mcpServers":{"global-server":{"enabled":false}}}', revision: "missing" }]);
  await service.commit(plan.token, true); assert.ok(existsSync(join(project, ".pi", "mcp.json"))); assert.equal(existsSync(join(agent, "mcp.json")), false);
  await assert.rejects(service.prepare({ workspaceId: "project" }, [{ kind: "models", text: "{}", revision: doc(snapshot, "models").revision }]), /全局/);
  await assert.rejects(service.snapshot({ workspaceId: "not-authorized" }), /unknown workspace/);
});

test("broken JSON is surfaced, can be explicitly repaired, and cannot be silently patched", async (t) => {
  const { service, agent, put } = fixture(t); put(join(agent, "settings.json"), "{broken json");
  const d = doc(await service.snapshot({}), "settings"); assert.ok(d.error); assert.equal(d.text, "{broken json");
  const plan = await service.prepare({}, [{ kind: "settings", text: '{"repaired":true}', revision: d.revision }]);
  assert.match(plan.changes[0]!.diff, /-\{broken json/); await service.commit(plan.token, true);
  put(join(agent, "zeonest-pi-settings.json"), "{invalid");
  await assert.rejects(service.prepare({}, [{ kind: "settings", text: "{}", revision: "missing" }]), /修复页面偏好/);
  const state = await service.snapshot({}); const repair = await service.prepare({}, [{ kind: "preferences", text: "{}", revision: doc(state, "preferences").revision }]);
  await service.commit(repair.token, true);
});

test("escaping config links are refused; safe internal links are preserved", async (t) => {
  const { service, agent, root, put } = fixture(t); put(join(root, "outside.json"), "{}"); symlinkSync(join(root, "outside.json"), join(agent, "settings.json"));
  const state = await service.snapshot({}); assert.equal(doc(state, "settings").revision, "unreadable");
  await assert.rejects(service.prepare({}, [{ kind: "settings", text: "{}", revision: "unreadable" }]), /授权目录之外/);
  rmSync(join(agent, "settings.json")); put(join(agent, "real.json"), "{}"); symlinkSync("real.json", join(agent, "settings.json"));
  const d = doc(await service.snapshot({}), "settings"); const plan = await service.prepare({}, [{ kind: "settings", text: '{"x":1}', revision: d.revision }]);
  await service.commit(plan.token, true); assert.equal(readFileSync(join(agent, "real.json"), "utf8"), '{"x":1}');
});

test("skill edits and automatic-invocation changes share the diff transaction", async (t) => {
  const { service, agent, put } = fixture(t); const path = join(agent, "skills", "sample", "SKILL.md");
  put(path, "---\nname: sample\ndescription: A sample skill\n---\nInstructions\n");
  const snapshot = await service.snapshot({}); const skill = snapshot.resources.find((r) => r.kind === "skill")!; assert.equal(skill.name, "sample");
  const content = await service.readResource({}, skill.id); const text = content.text.replace("Instructions", "New instructions");
  const plan = await service.prepareResource({}, skill.id, text, content.revision); assert.equal(readFileSync(path, "utf8"), content.text);
  await service.commit(plan.token, true); assert.equal(readFileSync(path, "utf8"), text);
  await assert.rejects(service.readResource({}, "../../auth.json"), /资源已/);
});

test("package disabling preserves and restores every resource filter", async (t) => {
  const { service, agent, put } = fixture(t);
  const entry = { source: "npm:example", extensions: ["one.ts", "!two.ts"], autoload: false, unknown: { x: 1 } };
  put(join(agent, "settings.json"), JSON.stringify({ packages: [entry], untouched: true }));
  let snapshot = await service.snapshot({});
  const make = (action: "enable" | "disable") => service.preparePackage({}, { action, source: entry.source, revision: doc(snapshot, "settings").revision, preferencesRevision: doc(snapshot, "preferences").revision });
  const off = await make("disable"); assert.equal(off.changes.length, 2); await service.commit(off.token, true);
  snapshot = await service.snapshot({}); assert.equal(snapshot.packages[0]!.enabled, false);
  const on = await make("enable"); await service.commit(on.token, true);
  assert.deepEqual(parseObject(readFileSync(join(agent, "settings.json"), "utf8")).packages, [entry]);
});

test("network package work is staged; config and payload are promoted only after review", async (t) => {
  let stage = "";
  const runner: Runner = async (executable, args, options) => {
    assert.equal(executable, "pi"); assert.deepEqual(args, ["install", "npm:example"]); assert.equal(options.env.npm_config_ignore_scripts, "true");
    stage = options.env.PI_CODING_AGENT_DIR!;
    assert.deepEqual(parseObject(readFileSync(join(stage, "settings.json"), "utf8")).npmCommand, ["npm", "--ignore-scripts"]);
    mkdirSync(join(stage, "npm", "node_modules", "example"), { recursive: true });
    writeFileSync(join(stage, "npm", "node_modules", "example", "index.js"), "throw new Error('MUST NOT LOAD')");
    writeFileSync(join(stage, "npm", "package.json"), '{"dependencies":{"example":"1.0.0"}}');
    writeFileSync(join(stage, "settings.json"), '{"packages":["npm:example"]}');
  };
  const { service, agent } = fixture(t, runner); const snapshot = await service.snapshot({});
  const plan = await service.preparePackage({}, { action: "install", source: "npm:example", revision: "missing", preferencesRevision: doc(snapshot, "preferences").revision });
  assert.equal(existsSync(join(agent, "npm")), false); assert.equal(existsSync(join(agent, "settings.json")), false);
  assert.ok(plan.artifacts[0]!.added > 0); assert.ok(plan.changes.some((c) => c.path.endsWith("npm/package.json")));
  await service.commit(plan.token, true); assert.equal(existsSync(join(agent, "npm", "node_modules", "example", "index.js")), true);
  assert.equal(existsSync(stage), false);
});

test("staging errors, cancellation and payload conflicts do not touch live installation", async (t) => {
  let shouldFail = true;
  const runner: Runner = async (_, _args, options) => {
    if (shouldFail) throw new Error("offline");
    const agent = options.env.PI_CODING_AGENT_DIR!; mkdirSync(join(agent, "npm"), { recursive: true }); writeFileSync(join(agent, "npm", "new"), "new");
    writeFileSync(join(agent, "settings.json"), '{"packages":["npm:example"]}');
  };
  const { service, agent, put } = fixture(t, runner);
  const request = { action: "install" as const, source: "npm:example", revision: "missing", preferencesRevision: "missing" };
  await assert.rejects(service.preparePackage({}, request), /offline/); assert.equal(existsSync(join(agent, "npm")), false);
  shouldFail = false; const plan = await service.preparePackage({}, request); service.discard(plan.token); assert.equal(existsSync(join(agent, "npm")), false);
  const next = await service.preparePackage({}, request); put(join(agent, "npm", "external"), "concurrent");
  await assert.rejects(service.commit(next.token, true), /安装目录/); assert.equal(readFileSync(join(agent, "npm", "external"), "utf8"), "concurrent");
  assert.equal(existsSync(join(agent, "settings.json")), false);
});

test("project .pi symlinks cannot redirect writes into the global agent directory", async (t) => {
  const { service, agent, project } = fixture(t); symlinkSync(agent, join(project, ".pi"));
  await assert.rejects(service.snapshot({ workspaceId: "project" }), /授权目录之外/);
});

test("multi-file failure rolls back earlier writes and releases locks for retry", async (t) => {
  let writes = 0;
  const { service, agent, put } = fixture(t, undefined, undefined, (target, text, mode) => {
    if (++writes === 2) throw new Error("simulated disk failure"); atomicWrite(target, text, mode);
  });
  put(join(agent, "settings.json"), '{"old":true}'); put(join(agent, "models.json"), "{}");
  const snapshot = await service.snapshot({});
  const plan = await service.prepare({}, [
    { kind: "settings", text: '{"new":true}', revision: doc(snapshot, "settings").revision },
    { kind: "models", text: '{"providers":{}}', revision: doc(snapshot, "models").revision },
  ]);
  await assert.rejects(service.commit(plan.token, true), /simulated disk failure/);
  assert.equal(readFileSync(join(agent, "settings.json"), "utf8"), '{"old":true}'); assert.equal(readFileSync(join(agent, "models.json"), "utf8"), "{}");
  await service.commit(plan.token, true); assert.equal(readFileSync(join(agent, "settings.json"), "utf8"), '{"new":true}');
});

test("a package payload is restored if its configuration write fails", async (t) => {
  const runner: Runner = async (_, _args, options) => {
    const stage = options.env.PI_CODING_AGENT_DIR!; mkdirSync(join(stage, "npm"), { recursive: true }); writeFileSync(join(stage, "npm", "payload"), "new");
    writeFileSync(join(stage, "settings.json"), '{"packages":["npm:example"]}');
  };
  const { service, agent, put } = fixture(t, runner, undefined, () => { throw new Error("disk failure"); });
  put(join(agent, "npm", "payload"), "original");
  const plan = await service.preparePackage({}, { source: "npm:example", action: "install", revision: "missing", preferencesRevision: "missing" });
  await assert.rejects(service.commit(plan.token, true), /disk failure/);
  assert.equal(readFileSync(join(agent, "npm", "payload"), "utf8"), "original"); assert.equal(existsSync(join(agent, "settings.json")), false);
});

test("preferences, settings and package plans conflict across clients", async (t) => {
  const { service } = fixture(t);
  const settings = await service.prepare({}, [{ kind: "settings", text: "{}", revision: "missing" }]);
  const prefs = await service.prepare({}, [{ kind: "preferences", text: '{"agentDir":"/some/other/path"}', revision: "missing" }]);
  await service.commit(prefs.token, true);
  await assert.rejects(service.commit(settings.token, true), /目录已改变|其他客户端/);
});
