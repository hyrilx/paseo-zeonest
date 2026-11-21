import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { formatArguments, parseArguments } from "../shared/arguments";
import { workspaceRoot } from "../server/paths";
import { discoverProjects } from "../server/projects";
import { buildArguments, toolchains, type Tool } from "../server/toolchains";
import { Workbench } from "../server/workbench";

function fixture(t: { after(fn: () => void): void }) {
  const root = workspaceRoot(mkdtempSync(join(tmpdir(), "zeonest-options-")));
  const put = (file: string, content: string, exec = false) => {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, exec ? `#!${process.execPath}\n${content}` : content, { mode: exec ? 0o700 : 0o600 });
    return path;
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, put };
}
const tool: Tool = { candidate: { id: "fixture", label: "fixture", paths: [], requirement: "" }, signature: "fixture", executable: "tool", env: {} };

test("form options roundtrip quoted arguments, literal shell syntax, and empty script arguments", () => {
  const args = ["--name", "with spaces", "", "$(literal)", "a\\b", 'one"two', "'three'", "-DNAME=A&B;C"];
  assert.deepEqual(parseArguments(formatArguments(args)), args);
  assert.deepEqual(parseArguments(`--features 'ui fast' x\\ y "abc"'def'`), ["--features", "ui fast", "x y", "abcdef"]);
  assert.throws(() => parseArguments(`--title "unfinished`), /未闭合/u);
  assert.throws(() => parseArguments("end\\"), /末尾/u);
});

test("stack options compile to native arguments without changing the chosen operation", (t) => {
  const { root, put } = fixture(t);
  put("package.json", '{"packageManager":"pnpm@11.0.0","scripts":{"build":"fixture"},"dependencies":{"@tauri-apps/cli":"^2"}}');
  put("src-tauri/tauri.conf.json", '{"build":{"frontendDist":"../dist"}}');
  put("src-tauri/Cargo.toml", '[package]\nname = "desktop"\n');
  put("Cargo.toml", '[package]\nname = "fixture"\n[profile.fast]\ninherits = "release"\n');
  put("targets/custom.json", '{}');
  put("tauri.extra.json", '{}');
  put("CMakeLists.txt", "cmake_minimum_required(VERSION 3.20)\nproject(Fixture)");
  const targets = discoverProjects(root).targets;
  const pick = (adapter: string) => {
    const found = targets.find((target) => target.adapter === adapter && (adapter !== "cargo" || target.project === "."));
    assert.ok(found);
    return found;
  };
  const mode = buildArguments(root, pick("pnpm"), ["--label", "two words", ""], tool);
  assert.deepEqual(mode.args, ["run", "build", "--label", "two words", ""]);
  const cargo = buildArguments(root, pick("cargo"), ["--profile", "fast", "--features=ui,fast", "--target", "targets/custom.json", "--target=x86_64-unknown-linux-gnu"], tool);
  assert.deepEqual(cargo.args, ["build", "--package", "fixture", "--profile", "fast", "--features=ui,fast", "--target", "targets/custom.json", "--target=x86_64-unknown-linux-gnu"]);
  assert.ok(cargo.outputs.includes("target/custom/fast/fixture"));
  assert.ok(cargo.outputs.includes("target/x86_64-unknown-linux-gnu/fast/fixture"));
  assert.throws(() => buildArguments(root, pick("cargo"), ["--target", "../outside.json"], tool), /有效的参数值/u);
  assert.throws(() => buildArguments(root, pick("cargo"), ["--manifest-path", "another/Cargo.toml"], tool), /不支持选项/u);
  const tauri = buildArguments(root, pick("tauri"), ["--release", "--features", "desktop", "--config", "tauri.extra.json", "--", "--locked"], tool);
  assert.deepEqual(tauri.args, ["exec", "tauri", "build", "--no-bundle", "--features", "desktop", "--config", "tauri.extra.json", "--", "--locked"]);
  assert.deepEqual(tauri.outputs, ["dist", "src-tauri/target/release/desktop"]);
  assert.throws(() => buildArguments(root, pick("tauri"), ["--bundles", "dmg"], tool), /不支持选项/u);
  const cmake = pick("cmake");
  assert.ok(!buildArguments(root, cmake, [], tool).args.includes("-G"));
  const c = buildArguments(root, cmake, ["-G", "Unix Makefiles", "-D", "CMAKE_BUILD_TYPE=Release"], tool);
  assert.deepEqual(c.args.slice(0, 4), ["-G", "Unix Makefiles", "-D", "CMAKE_BUILD_TYPE=Release"]);
  assert.throws(() => buildArguments(root, cmake, ["-B", "other"], tool), /不支持选项/u);
  assert.ok(cmake.cmake);
  const compiled = { ...cmake, operation: undefined, cmake: { ...cmake.cmake, configuration: "Debug", tool: tool.signature, target: "fixture" } };
  const build = buildArguments(root, compiled, ["--parallel", "--config", "Release"], tool);
  assert.deepEqual(build.args.slice(-5), ["--target", "fixture", "--parallel", "--config", "Release"]);
  assert.ok(!build.args.includes("Debug"));
});

test("optional protoc and Ninja are not run by tool verification; Tauri tries all installed Rust candidates", { skip: process.platform === "win32" }, async (t) => {
  const { root, put } = fixture(t);
  put("project/Cargo.toml", '[package]\nname = "fixture"\nrust-version = "1.90"\n');
  put("project/CMakeLists.txt", "cmake_minimum_required(VERSION 3.20)\nproject(Fixture)");
  put("project/Tauri.toml", "[build]\n");
  for (const [name, version] of [["aaa-old", "1.70.0"], ["bbb-new", "1.96.0"]]) {
    for (const exe of ["cargo", "rustc"]) put(`rust/toolchains/${name}/bin/${exe}`, `console.log('${exe} ${version}');`, true);
  }
  put("bin/cargo-tauri", "console.log('tauri-cli 2.0.0');", true);
  put("bin/cmake", "console.log('cmake version 4.0.0');", true);
  for (const exe of ["protoc", "ninja"]) put(`bin/${exe}`, "process.exit(17);", true);
  const workspace = { id: "project", root: join(root, "project") };
  const env = { PATH: join(root, "bin"), RUSTUP_HOME: join(root, "rust"), HOME: root };
  const w = new Workbench(join(root, "data"), env);
  t.after(() => w.close());
  for (const adapter of ["cargo", "cmake"] as const) {
    const target = w.discover(workspace).targets.find((target) => target.adapter === adapter);
    assert.ok(target);
    const candidates = w.tools(workspace, target).candidates;
    const selected = candidates.find(({ paths }) => adapter === "cmake" || paths.some((path) => path.includes("bbb-new")));
    assert.ok(selected);
    assert.ok((await w.verify(workspace, { target, tool: selected.id, options: [], artifacts: [] })).version);
  }
  const tauri = discoverProjects(workspace.root).targets.find((target) => target.adapter === "tauri");
  assert.ok(tauri);
  const rust = toolchains(tauri, env, new Map(), workspace.root);
  assert.equal(rust.length, 2);
  for (const channel of ["aaa-old", "bbb-new"]) assert.ok(rust.some((item) => item.candidate.paths.some((p) => p.includes(channel))));
});
