import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { live } from "../shared/contracts";
import type { Configuration } from "../shared/contracts";
import { installedExecutables } from "../server/mise";
import { workspaceRoot } from "../server/paths";
import { Workbench } from "../server/workbench";

test("project dependency preparation is previewed, shares one run and prevents build after failure or stop", { skip: process.platform === "win32", timeout: 15_000 }, async (t) => {
  const base = workspaceRoot(mkdtempSync(join(tmpdir(), "zeonest-prep-test-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  function put(path: string, body: string | object, exec = false) {
    const file = join(base, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body), { mode: exec ? 0o700 : 0o600 });
  }
  for (const manager of ["npm", "pnpm"]) put(`bin/${manager}`, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--versions') console.log(JSON.stringify({ node: process.versions.node, npm: '11.0.0' }));
else if (args[0] === '--version') console.log('11.0.0');
else if (args[0] === 'ci' || args[0] === 'install') {
  // An interrupted installer can leave apparently valid metadata before finishing.
  fs.mkdirSync('node_modules/fixture', { recursive: true });
  fs.writeFileSync('node_modules/fixture/package.json', '{"version":"1.0.0"}');
  console.log('INSTALL-START');
  if (fs.existsSync('fail')) process.exit(42);
  if (fs.existsSync('stall')) setInterval(() => {}, 100);
  else console.log('INSTALL-DONE');
} else {
  if (fs.existsSync('fail-build')) process.exit(43);
  fs.writeFileSync('built', 'yes');
  console.log('BUILD-DONE');
}
`, true);
  const env = { HOME: base, PATH: [join(base, "bin"), dirname(process.execPath)].join(delimiter) };
  const store = join(base, "runs");
  const workbench = new Workbench(store, env);
  t.after(() => workbench.close());
  function setup(id: string, mode?: "fail" | "stall", manager: "npm" | "pnpm" = "npm") {
    put(`${id}/projects/group/package.json`, { packageManager: `${manager}@11.0.0`, workspaces: ["packages/*"] });
    put(`${id}/projects/group/packages/app/package.json`, { name: "fixture-app", scripts: { build: "tool --build" }, devDependencies: { fixture: "1.0.0" } });
    put(`${id}/projects/group/${manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml"}`, "#".repeat(520 * 1024));
    if (manager === "pnpm") put(`${id}/projects/group/pnpm-workspace.yaml`, "packages: ['packages/*']");
    if (mode) put(`${id}/projects/group/${mode}`, "true");
    const workspace = { id, root: join(base, id) };
    const target = { adapter: manager, project: "projects/group/packages/app", name: "build" } as const;
    const tool = workbench.tools(workspace, target).candidates[0];
    assert.ok(tool);
    const config: Configuration = { target, tool: tool.id, options: [], artifacts: [] };
    return { workspace, config };
  }
  async function start({ workspace, config }: ReturnType<typeof setup>) {
    await workbench.verify(workspace, config);
    const preview = workbench.preview(workspace, config);
    assert.equal(preview.command.preparation?.[0]?.cwd, "projects/group");
    assert.equal(existsSync(join(workspace.root, "projects/group/node_modules")), false);
    assert.deepEqual(preview.command.preparation?.[0]?.argv.slice(1), config.target.adapter === "npm" ? ["install"] : ["install"]);
    const started = workbench.start(workspace, config, preview.fingerprint);
    assert.equal(started.kind, "started");
    return () => workbench.detail(workspace, started.run.id, 0);
  }
  async function settled(get: Awaited<ReturnType<typeof start>>, stop?: ReturnType<typeof setup>) {
    for (let i = 0; i < 250; i++) {
      const value = get();
      const log = value.rows.map((row) => row.text).join("");
      if (!live(value.run.status)) return { value, log };
      if (stop && log.includes("INSTALL-START")) workbench.stop(stop.workspace, value.run.id);
      await wait(30);
    }
    throw new Error("build preparation fixture timed out");
  }
  for (const manager of ["npm", "pnpm"] as const) {
    const success = setup(manager, undefined, manager);
    const done = await settled(await start(success));
    assert.equal(done.value.run.status, "success");
    assert.match(done.log, /INSTALL-START[\s\S]*INSTALL-DONE[\s\S]*BUILD-DONE/u);
    assert.ok(workbench.preview(success.workspace, success.config).command.preparation);
  }
  const failure = setup("failure", "fail");
  const fail = await settled(await start(failure));
  assert.equal(fail.value.run.status, "failed");
  assert.match(fail.value.run.result ?? "", /依赖准备未完成.*42/u);
  assert.doesNotMatch(fail.log, /BUILD-DONE/u);
  const stall = setup("stopped", "stall", "pnpm");
  const halted = await settled(await start(stall), stall);
  assert.equal(halted.value.run.status, "stopped");
  assert.doesNotMatch(halted.log, /BUILD-DONE/u);

  const buildFailure = setup("build-failure");
  put("build-failure/projects/group/packages/app/fail-build", "true");
  const build = await settled(await start(buildFailure));
  assert.equal(build.value.run.status, "failed");
  assert.equal(build.value.run.result, "退出码 43");
  await workbench.close();

  const reopened = new Workbench(store, env);
  t.after(() => reopened.close());
  for (const [{ workspace, config }, id, marker] of [
    [failure, fail.value.run.id, "fail"], [stall, halted.value.run.id, "stall"],
  ] as const) {
    assert.ok(reopened.preview(workspace, config).command.preparation, "ordinary Run also rechecks the partial install");
    const changed = reopened.retry(workspace, id);
    assert.equal(changed.kind, "changed");
    assert.ok(changed.command.preparation?.length);
    rmSync(join(workspace.root, "projects/group", marker));
    await reopened.verify(workspace, config);
    const afterVerify = reopened.retry(workspace, id, undefined, true);
    assert.equal(afterVerify.kind, "changed");
    assert.ok(afterVerify.command.preparation?.length);
    assert.equal(reopened.list(workspace).length, 1, "retry preview does not create a run");
    const retry = marker === "fail" ? reopened.start(workspace, config, reopened.preview(workspace, config).fingerprint) : reopened.retry(workspace, id, afterVerify.fingerprint);
    assert.equal(retry.kind, "started");
    assert.notEqual(retry.run.id, id);
    const result = await settled(() => reopened.detail(workspace, retry.run.id, 0));
    assert.equal(result.value.run.status, "success");
    assert.match(result.log, /INSTALL-START[\s\S]*INSTALL-DONE[\s\S]*BUILD-DONE/u);
  }
  await reopened.verify(buildFailure.workspace, buildFailure.config);
  const onlyBuild = reopened.retry(buildFailure.workspace, build.value.run.id, undefined, true);
  assert.equal(onlyBuild.kind, "changed");
  assert.ok(onlyBuild.command.preparation, "the native manager checks readiness incrementally each time");
});

test("npm/pnpm never infer complete installs from lock, package versions, or generated PnP loaders", { skip: process.platform === "win32" }, (t) => {
  const root = workspaceRoot(mkdtempSync(join(tmpdir(), "zeonest-layout-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function file(name: string, content: string, executable = false) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { mode: executable ? 0o700 : 0o600 });
    return path;
  }
  for (const manager of ["npm", "pnpm"] as const) {
    file(`bin/${manager}`, "must not run", true);
    file(`${manager}/package.json`, JSON.stringify({ packageManager: manager + "@11", scripts: { build: "fixture" }, dependencies: { fixture: "^1" } }));
  }
  file("npm/package-lock.json", "{}");
  const pkg = file("npm/node_modules/fixture/package.json", '{"version":"2.0.0"}');
  const lock = file("pnpm/pnpm-lock.yaml", "lockfileVersion: '9.0'");
  file("pnpm/.pnp.cjs", "generated");
  const w = new Workbench(join(root, "store"), { PATH: [join(root, "bin"), dirname(process.execPath)].join(delimiter), HOME: root });
  t.after(() => w.close());
  function needsPreparation(adapter: "npm" | "pnpm") {
    const workspace = { id: adapter, root: join(root, adapter) };
    const target = { adapter, project: ".", name: "build" };
    const tool = w.tools(workspace, target).candidates[0];
    assert.ok(tool);
    return !!w.preview(workspace, { target, tool: tool.id, options: [], artifacts: [] }).command.preparation;
  }
  assert.equal(needsPreparation("npm"), true);
  writeFileSync(pkg, '{"version":"1.2.0"}');
  assert.equal(needsPreparation("npm"), true);
  assert.equal(needsPreparation("pnpm"), true);
  const future = new Date(Date.now() + 5_000);
  utimesSync(lock, future, future);
  assert.equal(needsPreparation("pnpm"), true);
});

test("mise discovery locates app bundle layouts and executables provided by another package", { skip: process.platform === "win32" }, (t) => {
  const data = workspaceRoot(mkdtempSync(join(tmpdir(), "zeonest-mise-test-")));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const cmake = join(data, "installs/cmake/4.5.1/cmake-4.5.1-macos-universal/CMake.app/Contents/bin/cmake");
  const protoc = join(data, "installs/protobuf/36.2/bin/protoc");
  const bundled = join(data, "installs/tool-bundle/1.0/bin/flex");
  for (const exe of [cmake, protoc, bundled]) {
    mkdirSync(dirname(exe), { recursive: true });
    writeFileSync(exe, "discovery must not execute tools", { mode: 0o700 });
  }
  const env = { PATH: "/nonexistent", MISE_DATA_DIR: data };
  assert.deepEqual(installedExecutables("cmake", env), [cmake]);
  assert.deepEqual(installedExecutables("protoc", env), [protoc]);
  assert.deepEqual(installedExecutables("flex", env), [bundled]);
});
