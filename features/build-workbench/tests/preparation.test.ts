import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  console.log('INSTALL-START');
  if (fs.existsSync('fail')) process.exit(42);
  if (fs.existsSync('stall')) setInterval(() => {}, 100);
  else {
    fs.mkdirSync('node_modules/fixture', { recursive: true });
    fs.writeFileSync('node_modules/fixture/package.json', '{}');
    console.log('INSTALL-DONE');
  }
} else {
  fs.writeFileSync('built', 'yes');
  console.log('BUILD-DONE');
}
`, true);
  const env = { HOME: base, PATH: [join(base, "bin"), dirname(process.execPath)].join(delimiter) };
  const workbench = new Workbench(join(base, "runs"), env);
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
    assert.deepEqual(preview.command.preparation?.[0]?.argv.slice(1), config.target.adapter === "npm" ? ["ci", "--include=dev"] : ["install", "--prod=false", "--frozen-lockfile"]);
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
    assert.equal(workbench.preview(success.workspace, success.config).command.preparation, undefined);
  }
  const fail = await settled(await start(setup("failure", "fail")));
  assert.equal(fail.value.run.status, "failed");
  assert.match(fail.value.run.result ?? "", /依赖准备未完成.*42/u);
  assert.doesNotMatch(fail.log, /BUILD-DONE/u);
  const stall = setup("stopped", "stall");
  const halted = await settled(await start(stall), stall);
  assert.equal(halted.value.run.status, "stopped");
  assert.doesNotMatch(halted.log, /BUILD-DONE/u);
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
