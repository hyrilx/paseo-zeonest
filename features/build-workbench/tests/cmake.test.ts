import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { finishCmake, prepareCmake } from "../server/cmake";
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
  const discovery = () => discoverProjects(root).targets.filter((t) => t.adapter === "cmake");
  const configure = discovery()[0]?.cmake;
  assert.ok(configure);
  assert.deepEqual(discovery().map((t) => t.name), ["configure"]);
  prepareCmake(root, configure.dir);
  const reply = `${configure.dir}/.cmake/api/v1/reply`;
  put(`${configure.dir}/CMakeCache.txt`, `CMAKE_HOME_DIRECTORY:INTERNAL=${root}\n`);
  put(`${reply}/index-0000.json`, { reply: { "codemodel-v2": { jsonFile: "codemodel.json" } } });
  put(`${reply}/codemodel.json`, { configurations: [{ name: "Debug", targets: [
    { name: "example", jsonFile: "example.json" }, { name: "-bad", jsonFile: "example.json" },
    { name: "utility", jsonFile: "utility.json" }, { name: "outside", jsonFile: "../outside.json" },
  ] }] });
  put(`${reply}/example.json`, { type: "EXECUTABLE", artifacts: [{ path: "apps/example" }, { path: join(root, "outside") }, { path: "../outside" }] });
  put(`${reply}/utility.json`, { type: "UTILITY" });
  assert.deepEqual(discovery().map((t) => t.name), ["configure"]);
  finishCmake(root, configure.dir, configure.stamp, "chosen-tool");
  const [, example] = discovery();
  assert.deepEqual(discovery().map((t) => t.name), ["configure", "example"]);
  assert.equal(example?.cmake?.tool, "chosen-tool");
  assert.deepEqual(example?.outputs, [`${configure.dir}/apps/example`]);
  put("apps/CMakeLists.txt", "add_executable(player player.cpp)");
  assert.deepEqual(discovery().map((t) => t.name), ["configure"]);
});
