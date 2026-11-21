import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type { Configuration } from "../shared/contracts";
import { discoverProjects } from "../server/projects";
import { workspaceRoot } from "../server/paths";
import { conflicts, Workbench } from "../server/workbench";
import { matchesVersion } from "../server/toolchains";

function fixture(t: { after(fn: () => void): void }) {
  const base = workspaceRoot(mkdtempSync(join(tmpdir(), "zeonest-build-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}
const manifest = (root: string, data: object) => writeFileSync(join(root, "package.json"), JSON.stringify(data));

async function until<T>(get: () => T, ok: (value: T) => boolean) {
  for (let i = 0; i < 300; i++) {
    const value = get();
    if (ok(value)) return value;
    await wait(40);
  }
  throw new Error("timed out waiting for build fixture");
}

test("static discovery is bounded, never runs scripts and keeps package identities", (t) => {
  const base = fixture(t);
  assert.match(discoverProjects(base).notices.join(), /未找到任务/u);
  writeFileSync(join(base, "package.json"), "{");
  assert.match(discoverProjects(base).notices.join(), /无效 JSON/u);
  for (const leaf of ["apps/web", "apps/server", "other"]) {
    const root = join(base, leaf); mkdirSync(root, { recursive: true }); manifest(root, { scripts: { build: "touch SHOULD_NOT_EXIST" } });
  }
  symlinkSync(join(base, "other"), join(base, "apps", "outside"));
  manifest(base, { workspaces: ["apps/*", "apps/outside"], scripts: { build: "touch SHOULD_NOT_EXIST" } });
  assert.deepEqual(discoverProjects(base).targets.map((item) => item.project).sort(), [".", "apps/server", "apps/web", "other"]);
  assert.throws(() => readFileSync(join(base, "SHOULD_NOT_EXIST")), /ENOENT/u);
});

test("pnpm and Cargo declarations stay separate and preserve project pins", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "apps/web"), { recursive: true });
  mkdirSync(join(root, "crates/api"), { recursive: true });
  manifest(root, { packageManager: "pnpm@11.3.0", scripts: { build: "pnpm --filter ui build" } });
  manifest(join(root, "apps/web"), { files: ["dist/"], scripts: { build: "tsc -b && vite build" } });
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n");
  writeFileSync(join(root, "mise.toml"), '[tools]\nnode = "22"\n');
  writeFileSync(join(root, "apps/.mise.toml"), '[tools]\nnode = "24.14.0"\n');
  writeFileSync(join(root, "Cargo.toml"), '[workspace]\nmembers = [\n "crates/api",\n]\n');
  writeFileSync(join(root, "crates/api/Cargo.toml"), '[package]\nname = "api"\n');
  const { targets } = discoverProjects(root);
  const web = targets.find((entry) => entry.project === "apps/web");
  assert.deepEqual([web?.adapter, web?.requirements.miseNode, web?.requirements.manager, web?.outputs], ["pnpm", "24.14.0", "11.3.0", ["apps/web/dist"]]);
  const cargo = targets.find((entry) => entry.name === "api");
  assert.deepEqual([cargo?.adapter, cargo?.cwd, cargo?.cargo?.targetDir], ["cargo", ".", "target"]);
  assert.ok(targets.some((entry) => entry.adapter === "pnpm" && entry.project === "."));
});

test("Cargo leaves build.rs to Cargo and Tauri does not require a particular JS hook or lockfile", (t) => {
  const root = fixture(t);
  for (const dir of ["core", "proto", "desktop/src-tauri"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "core/Cargo.toml"), '[package]\nname = "core"\n');
  writeFileSync(join(root, "core/build.rs"), 'prost_build::Config::new().out_dir("src/protos").compile_protos(&["../proto/input.proto", "../../outside.proto"], &[]);');
  writeFileSync(join(root, "proto/input.proto"), 'syntax = "proto3";');
  writeFileSync(join(root, "desktop/src-tauri/Cargo.toml"), '[package]\nname = "desktop"\n');
  manifest(join(root, "desktop"), { scripts: { "tauri:check": "tauri info" }, dependencies: { "@tauri-apps/cli": "^2" } });
  writeFileSync(join(root, "desktop/src-tauri/tauri.conf.json5"), "{ // project-defined hook\n build: { frontendDist: '../assets', beforeBuildCommand: 'npm run generate', }, }");
  const { targets } = discoverProjects(root);
  const cargo = targets.find((entry) => entry.project === "core");
  assert.equal(cargo?.blocked, undefined);
  assert.ok(!cargo?.outputs.includes("core/src/protos"));
  const tauri = targets.find((entry) => entry.adapter === "tauri");
  assert.deepEqual(tauri?.outputs, ["desktop/assets", "desktop/src-tauri/target/debug/desktop"]);
  assert.equal(tauri?.tauri?.manager, "npm");
  assert.deepEqual(tauri?.install?.required, [{ from: "desktop", name: "@tauri-apps/cli", version: "^2" }]);
  assert.ok(targets.some((entry) => entry.adapter === "npm" && entry.name === "tauri:check"));
});

test("output locks are symmetric, including canonical directories shared by different scopes", () => {
  assert.equal(conflicts({ root: "/a" }, { root: "/a", locks: ["/a/out"] }), true);
  assert.equal(conflicts({ root: "/a", locks: ["/a/out/one"] }, { root: "/a", locks: ["/a/out/two"] }), false);
  assert.equal(conflicts({ root: "/a", locks: ["/a/out"] }, { root: "/a/out", locks: ["/a/out/nested"] }), true);
  assert.equal(matchesVersion("v24.14.0", ">=22 <25"), true);
  assert.equal(matchesVersion("11.20.1", "11.20.0"), false);
  assert.equal(matchesVersion("v22.3.1", "20.0.0 - 20.9.0 || 22.x"), true);
});

test("workspace ownership, queued conflict, independent output, parent/child stop and failed retry", { skip: process.platform === "win32", timeout: 18_000 }, async (t) => {
  const base = fixture(t);
  const roots = ["a", "b"].map((id) => { const root = join(base, id); mkdirSync(root); return { id, root }; });
  const [a, b] = roots as [typeof roots[number], typeof roots[number]];
  const bin = join(base, "bin"); mkdirSync(bin);
  // A local stand-in for npm does not depend on the host's package-manager installation.
  const npm = join(bin, "npm");
  writeFileSync(npm, `#!${process.execPath}\nconst { spawn } = require('node:child_process');\nconst fs = require('node:fs');\nif (process.argv[2] === '--versions') console.log(JSON.stringify({ node: process.versions.node, npm: '11.0.0' }));\nelse if (process.argv[3] === 'build') {\n  spawn(process.execPath, ['-e', 'setTimeout(() => require("node:fs").writeFileSync("escaped", "bad"), 2100)'], {stdio:'ignore'});\n  console.log('START-A');\n  setInterval(() => {}, 100);\n} else if (process.argv[3] === 'fail') {\n  console.log('z'.repeat(110000)); console.error('OLD-LOG'); process.exitCode = 7;\n} else { fs.writeFileSync('built.txt', 'done'); console.log('DONE-B'); setTimeout(() => {}, 800); }\n`, { mode: 0o700 });
  manifest(a.root, { engines: { node: ">=22" }, scripts: { build: "expected", check: "expected", fail: "expected" } });
  manifest(b.root, { scripts: { check: "expected" } });
  symlinkSync(b.root, join(a.root, "outside"));
  const data = join(base, "data");
  const env = { PATH: [bin, dirname(process.execPath)].join(delimiter) };
  const workbench = new Workbench(data, env);
  t.after(() => workbench.close());
  const target = (name: string) => ({ adapter: "npm" as const, project: ".", name });
  const configuration = async (w: typeof a, name: string): Promise<Configuration> => {
    const candidate = workbench.tools(w, target(name)).candidates[0];
    assert.ok(candidate);
    const config = { target: target(name), tool: candidate.id, options: [], artifacts: ["built.txt"] };
    await workbench.verify(w, config);
    return config;
  };
  function submit(w: typeof a, c: Configuration) {
    const result = workbench.start(w, c, workbench.preview(w, c).fingerprint);
    assert.equal(result.kind, "started");
    return result.run;
  }
  const ca = await configuration(a, "build");
  const cb = await configuration(b, "check");
  assert.throws(() => workbench.preview(a, { ...ca, artifacts: ["../b"] }), /相对路径/u);
  assert.throws(() => workbench.preview(a, { ...ca, artifacts: ["outside/file"] }), /符号链接/u);
  assert.deepEqual(workbench.preview(a, { ...ca, options: ["--prefix", "/tmp/with spaces", "$(literal)", ""] }).command.argv.slice(1),
    ["run", "build", "--", "--prefix", "/tmp/with spaces", "$(literal)", ""]);
  const one = submit(a, ca);
  const queued = submit(a, { ...ca, target: target("check") });
  const two = submit(b, cb);
  assert.equal(one.status, "running"); assert.equal(queued.status, "queued"); assert.equal(two.status, "running");
  assert.throws(() => workbench.detail(b, one.id, 0), /当前工作区/u);
  assert.throws(() => workbench.stop(b, one.id), /当前工作区/u);
  await until(() => workbench.detail(a, one.id, 0), (d) => d.rows.some((row) => row.text.includes("START-A")));
  assert.equal(workbench.stop(a, queued.id).status, "stopped");
  assert.equal(workbench.stop(a, one.id).status, "stopping");
  await until(() => workbench.detail(a, one.id, 0), (d) => d.run.status === "stopped");
  const success = await until(() => workbench.detail(b, two.id, 0), (d) => d.run.status === "success");
  assert.match(success.rows.map((r) => r.text).join(""), /DONE-B/u);
  assert.deepEqual(success.artifacts.filter((item) => item.state !== "missing"), [{ path: "built.txt", state: "new" }]);
  const failed = submit(a, { ...ca, target: target("fail") });
  const failure = await until(() => workbench.detail(a, failed.id, 0), (d) => d.run.status === "failed");
  assert.equal(failure.truncated, true);
  assert.equal(failure.run.result, "退出码 7");
  manifest(a.root, { engines: { node: ">=22" }, scripts: { build: "expected", fail: "changed declaration" } });
  const changed = workbench.retry(a, failed.id);
  assert.equal(changed.kind, "changed");
  const retried = workbench.retry(a, failed.id, changed.fingerprint);
  assert.equal(retried.kind, "started"); assert.notEqual(retried.run.id, failed.id);
  await until(() => workbench.detail(a, retried.run.id, 0), (d) => d.run.status === "failed");
  assert.deepEqual(workbench.detail(a, failed.id, 0).rows, failure.rows);
  assert.throws(() => workbench.retry(a, queued.id), /删除、移动/u);
  workbench.save(a, { ...ca, name: "A only" });
  assert.deepEqual(workbench.discover(b).configurations, []);
  await wait(2200);
  assert.throws(() => readFileSync(join(a.root, "escaped")), /ENOENT/u);
  workbench.close();
  const reopened = new Workbench(data, env);
  assert.equal(reopened.discover(a).configurations[0]?.name, "A only");
  assert.equal(reopened.list(b)[0]?.id, two.id);
});
