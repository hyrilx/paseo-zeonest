import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Workbench, type Workspace } from "../server/workbench";
import { cmakeBuildDir, finishCmake, prepareCmake } from "../server/cmake";
import { workspaceRoot } from "../server/paths";
import { discoverProjects } from "../server/projects";

test("CMake targets require a fresh explicit File API result and stay in their build directory", (t) => {
  const root = workspaceRoot(mkdtempSync(join(tmpdir(), "zeonest-cmake-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function put(path: string, value: string | object) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  }
  put("CMakeLists.txt", "cmake_minimum_required(VERSION 3.20)\nproject(Fixture)\nadd_subdirectory(apps)");
  put("apps/CMakeLists.txt", "add_executable(example example.cpp)");
  put("options.cmake", "set(NATIVE_SETTING on)");
  const discovery = () => discoverProjects(root).targets.filter((t) => t.adapter === "cmake");
  const configure = discovery()[0]?.cmake;
  assert.ok(configure);
  assert.deepEqual(discovery().map((t) => t.name), ["configure"]);
  const dir = cmakeBuildDir(configure.dir, "chosen-tool", []);
  assert.notEqual(dir, cmakeBuildDir(configure.dir, "chosen-tool", ["-G", "Ninja"]));
  prepareCmake(root, configure.dir, dir);
  const reply = `${dir}/.cmake/api/v1/reply`;
  put(`${dir}/CMakeCache.txt`, `CMAKE_HOME_DIRECTORY:INTERNAL=${root}\nCMAKE_GENERATOR:INTERNAL=Ninja Multi-Config\nCMAKE_DEFAULT_BUILD_TYPE:STRING=Release\nfmt_DIR:PATH=fmt_DIR-NOTFOUND\nOptionalThing_DIR:PATH=OptionalThing_DIR-NOTFOUND\n`);
  put(`${reply}/index-0000.json`, { reply: { "codemodel-v2": { jsonFile: "codemodel.json" }, "cmakeFiles-v1": { jsonFile: "cmake-files.json" } } });
  put(`${reply}/cmake-files.json`, { inputs: [{ path: "options.cmake" }] });
  put(`${reply}/codemodel.json`, { configurations: [{ name: "Debug", targets: [
    { name: "example", jsonFile: "example.json" }, { name: "-bad", jsonFile: "example.json" },
    { name: "utility", jsonFile: "utility.json" }, { name: "outside", jsonFile: "../outside.json" },
  ] }, { name: "Release", targets: [{ name: "example", jsonFile: "release.json" }] }] });
  put(`${reply}/release.json`, { type: "EXECUTABLE", artifacts: [{ path: "Release/example" }] });
  put(`${reply}/example.json`, { type: "EXECUTABLE", artifacts: [{ path: "apps/example" }, { path: join(root, "outside") }, { path: "../outside" }] });
  put(`${reply}/utility.json`, { type: "UTILITY" });
  assert.deepEqual(discovery().map((t) => t.name), ["configure"]);
  finishCmake(root, ".", configure.dir, dir, configure.stamp, "chosen-tool");
  const [, example] = discovery();
  assert.deepEqual(discovery().map((t) => t.name), ["configure", "example"]);
  assert.equal(example?.cmake?.tool, "chosen-tool");
  assert.equal(example?.blocked, undefined);
  assert.deepEqual(example?.outputs, [`${dir}/Release/example`]);
  assert.deepEqual(example?.cmake?.configurations?.Release, [`${dir}/Release/example`]);
  put("options.cmake", "set(NATIVE_SETTING off)");
  assert.deepEqual(discovery().map((t) => t.name), ["configure"]);
  put("options.cmake", "set(NATIVE_SETTING on)");
  assert.deepEqual(discovery().map((t) => t.name), ["configure", "example"]);
  put("apps/CMakeLists.txt", "add_executable(player player.cpp)");
  assert.deepEqual(discovery().map((t) => t.name), ["configure"]);
});

test("CMake rechecks relative and absolute external inputs and locks shared writes by configuration", { skip: process.platform === "win32" }, async (t) => {
  const base = workspaceRoot(mkdtempSync(join(tmpdir(), "zeonest-cmake-external-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const put = (path: string, value: string, mode = 0o600) => {
    const file = join(base, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value, { mode });
  };
  put("layout.cmake", "relative input");
  put("named.cmake", "absolute input");
  put("bin/cmake", `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), root = process.cwd();
const base = path.dirname(root);
if (args[0] === '--version') console.log('cmake version 4.5.1');
else if (args[0] === '--build') {
  const shared = path.join(base, 'shared', 'portable');
  fs.mkdirSync(path.dirname(shared), { recursive:true });
  fs.writeFileSync(shared, 'output');
  setTimeout(() => {}, 500);
} else {
  const out = args[args.indexOf('-B') + 1];
  const reply = path.join(out, '.cmake/api/v1/reply');
  fs.mkdirSync(reply, { recursive:true });
  fs.writeFileSync(path.join(out, 'CMakeCache.txt'), 'CMAKE_HOME_DIRECTORY:INTERNAL='+root+'\\nCMAKE_GENERATOR:INTERNAL=Ninja Multi-Config\\nCMAKE_DEFAULT_BUILD_TYPE:STRING=Release\\n');
  const json = (name,obj) => fs.writeFileSync(path.join(reply,name+'.json'), JSON.stringify(obj));
  json('index-0001',{reply:{'codemodel-v2':{jsonFile:'model.json'},'cmakeFiles-v1':{jsonFile:'files.json'}}});
  fs.writeFileSync(path.join(out,'generated.cmake'), 'generated');
  json('files',{inputs:[{path:'../layout.cmake',isExternal:true},{path:path.join(base,'named.cmake'),isExternal:true},{path:path.relative(root,path.join(out,'generated.cmake')),isGenerated:true}]});
  json('model',{configurations:['Debug','Release'].map((name) => ({name,targets:[{name:'portable',jsonFile:name+'.json'}]}))});
  json('Debug',{type:'EXECUTABLE',artifacts:[{path:'Debug/portable'}]});
  json('Release',{type:'EXECUTABLE',artifacts:[{path:path.join(base,'shared','portable')}]});
}
`, 0o700);
  for (const id of ["left", "right"]) put(`${id}/CMakeLists.txt`, "cmake_minimum_required(VERSION 3.20)\nproject(Portable)\n");
  const w = new Workbench(join(base, "store"), { HOME: base, PATH: [join(base, "bin"), dirname(process.execPath)].join(delimiter) });
  t.after(() => w.close());
  const left = { id: "left", root: join(base, "left") }, right = { id: "right", root: join(base, "right") };
  const key = (name: string) => ({ project: ".", adapter: "cmake" as const, name });
  const configure = (ws: Workspace) => ({ target: key("configure"), options: [] as string[], artifacts: [], tool: w.tools(ws, key("configure")).candidates[0]!.id });
  const build = (ws: Workspace, options: string[]) => ({ ...configure(ws), target: key("portable"), options });
  const start = (ws: Workspace, c: ReturnType<typeof configure>) => {
    const reply = w.start(ws, c, w.preview(ws, c).fingerprint);
    assert.equal(reply.kind, "started");
    return reply.run;
  };
  const settle = async (ws: Workspace, id: string) => {
    for (let i = 0; i < 200; i++) {
      const out = w.detail(ws, id, 0);
      if (out.run.endedAt) return out;
      await delay(15);
    }
    assert.fail("run did not finish");
  };
  for (const ws of [left, right]) {
    const c = configure(ws);
    await w.verify(ws, c);
    const done = await settle(ws, start(ws, c).id);
    assert.equal(done.run.status, "success", done.run.result);
  }
  const defaultPlan = w.preview(left, build(left, []));
  assert.ok(!defaultPlan.command.argv.includes("--config"));
  assert.deepEqual(w.discover(left).targets.find(({ name }) => name === "portable")?.outputs, []);
  const explicit = w.preview(right, build(right, ["--config", "Release"]));
  assert.notEqual(defaultPlan.command.argv[2], explicit.command.argv[2]);
  assert.match(discoverProjects(left.root).targets.find(({ name }) => name === "portable")?.cmake?.configurations?.Debug?.[0] ?? "", /Debug\/portable/u);
  const first = start(left, build(left, []));
  const second = start(right, build(right, ["--config", "Release"]));
  assert.equal(first.status, "running");
  assert.equal(second.status, "queued");
  assert.deepEqual((await settle(left, first.id)).artifacts, []);
  assert.equal((await settle(right, second.id)).run.status, "success");
  for (const input of ["layout.cmake", "named.cmake"]) {
    put(input, `modified ${input}`);
    assert.throws(() => w.preview(left, build(left, [])), /已删除、移动或不可用/u);
    assert.equal((await settle(left, start(left, configure(left)).id)).run.status, "success");
    assert.notEqual(w.preview(left, build(left, [])).fingerprint, defaultPlan.fingerprint);
  }
});
