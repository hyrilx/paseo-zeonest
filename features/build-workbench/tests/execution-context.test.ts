import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { Configuration, TargetKey } from "../shared/contracts";
import { discoverProjects } from "../server/projects";
import { buildArguments, toolchains } from "../server/toolchains";
import { Workbench, type Workspace } from "../server/workbench";

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zeonest-context-")));
  const put = (name: string, contents: string | object, script = false) => {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, script ? `#!${process.execPath}\n${contents}` : typeof contents === "string" ? contents : JSON.stringify(contents), { mode: script ? 0o700 : 0o600 });
    return path;
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, put };
}

async function finish(w: Workbench, ws: Workspace, id: string) {
  for (let i = 0; i < 160; i++) {
    const value = w.detail(ws, id, 0);
    if (value.run.endedAt) return value;
    await delay(25);
  }
  assert.fail("run did not finish");
}

function config(w: Workbench, ws: Workspace, target: TargetKey, tool = w.tools(ws, target).candidates[0]?.id): Configuration {
  assert.ok(tool);
  return { target, tool, options: [], artifacts: [] };
}

function submit(w: Workbench, ws: Workspace, c: Configuration) {
  const reply = w.start(ws, c, w.preview(ws, c).fingerprint);
  assert.equal(reply.kind, "started");
  return reply.run;
}

test("pnpm root-only, brace and exclusions preserve native ownership; npm supports ordered re-inclusion", (t) => {
  const { root, put } = fixture(t);
  const scripts = { build: "not run by discovery" };
  put("package.json", { name: "root", packageManager: "pnpm@12", scripts });
  for (const name of ["a", "b", "blocked", "rogue"]) put(`packages/${name}/package.json`, { name, scripts });
  put("independent/package.json", { name: "separate", packageManager: "npm@11", scripts, workspaces: ["modules/*", "!modules/blocked", "modules/blocked"] });
  for (const name of ["ok", "blocked"]) put(`independent/modules/${name}/package.json`, { name, scripts });
  put("pnpm-workspace.yaml", "catalog: {}\n");
  const rootOnly = discoverProjects(root);
  assert.deepEqual(rootOnly.targets.map(({ project }) => project).sort(), [".", "independent", "independent/modules/blocked", "independent/modules/ok"]);
  assert.ok(rootOnly.notices.some((note) => note.includes("packages/a 不属于")));
  put("pnpm-workspace.yaml", "packages: ['!packages/blocked', 'packages/{a,b,blocked}']\n");
  const included = discoverProjects(root);
  for (const name of ["a", "b"]) {
    const project = included.targets.find((item) => item.project === `packages/${name}`);
    assert.equal(project?.adapter, "pnpm");
    assert.equal(project?.install?.cwd, ".");
  }
  assert.ok(!included.targets.some((item) => /packages\/(blocked|rogue)/u.test(item.project)));
  assert.equal(included.targets.find((item) => item.project === "independent/modules/blocked")?.install?.cwd, "independent");
  put("packages/a/.npmrc", "use-node-version=22\n");
  const runtime = discoverProjects(root);
  assert.ok(!runtime.targets.some((item) => item.project === "packages/a"));
  assert.ok(runtime.notices.some((note) => note.includes("运行时")));
});

test("Cargo implicit members inherit workspace context and path pin; external shared targets queue", { skip: process.platform === "win32" }, async (t) => {
  const { root, put } = fixture(t);
  const cargo = put("pinned/bin/cargo", `
if (process.argv.includes('--version')) console.log('cargo 1.96.0');
else {
  const fs = require('node:fs');
  const { resolve, join } = require('node:path');
  if (process.cwd().endsWith('/shared-b')) process.exit(0);
  const target = process.env.CARGO_TARGET_DIR || 'root-output';
  fs.mkdirSync(target, { recursive: true });
  const artifact = resolve(target, 'custom-name');
  fs.writeFileSync(artifact, 'result');
  console.log(JSON.stringify({ reason:'compiler-artifact', manifest_path:resolve('implicit/Cargo.toml'), filenames:[artifact] }));
  if (process.cwd().endsWith('/shared-a')) setTimeout(() => {}, 1000);
}`, true);
  put("pinned/bin/rustc", "console.log('rustc 1.96.0');", true);
  put("other/toolchains/stable-newer/bin/cargo", "console.log('cargo 1.99.0');", true);
  put("other/toolchains/stable-newer/bin/rustc", "console.log('rustc 1.99.0');", true);
  for (const name of ["local", "shared-a", "shared-b"]) {
    put(`${name}/Cargo.toml`, `[workspace]\nmembers=["explicit"]\n[workspace.package]\nrust-version="1.91"\n[workspace.dependencies]\ninherited={path="implicit"}\n`);
    put(`${name}/explicit/Cargo.toml`, `[package]\nname="explicit"\n[dependencies]\nrenamed={path="../implicit", package="implicit"}\n`);
    put(`${name}/implicit/Cargo.toml`, `[package]\nname="implicit"\nrust-version.workspace=true\n`);
    put(`${name}/rust-toolchain.toml`, '[toolchain]\npath="../pinned"\n');
    put(`${name}/.cargo/config.toml`, '[build]\ntarget-dir="root-output"\n');
    put(`${name}/implicit/.cargo/config.toml`, '[build]\ntarget-dir="member-output"\n');
  }
  const env = { HOME: root, RUSTUP_HOME: join(root, "other"), PATH: process.env.PATH };
  const local = { id: "local", root: join(root, "local") };
  const target = { adapter: "cargo", project: "implicit", name: "implicit" } as const;
  const project = discoverProjects(local.root).targets.find((item) => item.name === "implicit");
  assert.ok(project);
  assert.equal(project.cwd, ".");
  assert.equal(project.requirements.rust, "1.91");
  const candidates = toolchains(project, env, new Map(), local.root);
  assert.deepEqual(candidates.map((tool) => tool.executable), [cargo]);
  assert.equal(buildArguments(local.root, project, [], candidates[0]!).cargo?.targetDir, join(local.root, "root-output"));
  const localService = new Workbench(join(root, "local-state"), env);
  t.after(() => localService.close());
  const lc = config(localService, local, target);
  await localService.verify(local, lc);
  const detail = await finish(localService, local, submit(localService, local, lc).id);
  assert.deepEqual(detail.artifacts, [{ path: "root-output/custom-name", state: "existing", origin: "native" }]);
  put("local/rust-toolchain.toml", '[toolchain]\npath="../absent"\n');
  assert.equal(localService.tools(local, target).candidates.length, 0);
  assert.match(localService.tools(local, target).issues.join(""), /未找到 Cargo/u);

  const w = new Workbench(join(root, "shared-state"), { ...env, CARGO_TARGET_DIR: join(root, "shared") });
  t.after(() => w.close());
  const a = { id: "a", root: join(root, "shared-a") }, b = { id: "b", root: join(root, "shared-b") };
  const ca = config(w, a, target), cb = config(w, b, target);
  await w.verify(a, ca);
  await w.verify(b, cb);
  const first = submit(w, a, ca), second = submit(w, b, cb);
  assert.equal(first.status, "running");
  assert.equal(second.status, "queued");
  assert.deepEqual((await finish(w, a, first.id)).artifacts, [], "external outputs cannot be browsed");
  assert.equal((await finish(w, b, second.id)).run.status, "success");
});

test("Tauri rejects ambiguous apps and selected child Node/Cargo do not shadow unrelated commands", { skip: process.platform === "win32" }, async (t) => {
  const { root, put } = fixture(t);
  const workspace = { id: "ui", root: join(root, "ui") };
  put("ui/package.json", { packageManager: "npm@11", dependencies: { "@tauri-apps/cli": "^2" } });
  for (const app of ["src-tauri", "secondary"]) {
    put(`ui/${app}/Cargo.toml`, `[package]\nname="${app}"\n`);
    put(`ui/${app}/tauri.conf.json`, {});
  }
  assert.ok(!discoverProjects(workspace.root).targets.some(({ adapter }) => adapter === "tauri"));
  rmSync(join(workspace.root, "secondary"), { recursive: true, force: true });
  put("host/cc", "console.log('host-compiler')", true);
  put("host/cargo", "console.log('cargo 1.70.0')", true);
  put("host/npm", `
const fs = require('node:fs'), cp = require('node:child_process');
const call = (cmd, args) => cp.execFileSync(cmd, args, {encoding:'utf8'}).trim();
if (process.argv.includes('--versions')) console.log(JSON.stringify({node:call('node',['-p','process.versions.node']), npm:'11.20.0'}));
else if (process.argv.includes('build')) fs.writeFileSync('resolved', JSON.stringify([call('node',['-p','process.execPath']), call('cargo',['--version']), call('cc',[]), call('protoc',[])]));`, true);
  put("rust/toolchains/selected/bin/cargo", "console.log('cargo 1.96.0')", true);
  put("rust/toolchains/selected/bin/rustc", "console.log('rustc 1.96.0')", true);
  put("rust/toolchains/selected/bin/cc", "console.log('wrong-rust-compiler')", true);
  put("mise/installs/protobuf/36.2/bin/protoc", "console.log('protoc from mise')", true);
  put("mise/installs/protobuf/36.2/bin/cc", "console.log('wrong-optional-compiler')", true);
  const env = { HOME: root, MISE_DATA_DIR: join(root, "mise"), RUSTUP_HOME: join(root, "rust"), PATH: [join(root, "host"), dirname(process.execPath)].join(delimiter) };
  const w = new Workbench(join(root, "state"), env);
  t.after(() => w.close());
  const target = w.discover(workspace).targets.find(({ adapter }) => adapter === "tauri");
  assert.ok(target);
  const selected = w.tools(workspace, target).candidates.find(({ paths }) => paths.includes(join(root, "host/npm")) && paths.includes(join(dirname(process.execPath), "node")));
  assert.ok(selected);
  const c = config(w, workspace, target, selected.id);
  await w.verify(workspace, c);
  const result = await finish(w, workspace, submit(w, workspace, c).id);
  assert.equal(result.run.status, "success");
  const values = JSON.parse(readFileSync(join(workspace.root, "resolved"), "utf8")) as string[];
  assert.equal(realpathSync(values[0]!), realpathSync(selected.paths[0]!));
  assert.deepEqual(values.slice(1), ["cargo 1.96.0", "host-compiler", "protoc from mise"]);
  put("ui/node_modules/.bin/cargo", "process.exit(18)", true);
  const blocked = await finish(w, workspace, submit(w, workspace, c).id);
  assert.equal(blocked.run.status, "failed");
  assert.match(blocked.run.result ?? "", /会覆盖所选 cargo/u);
});
