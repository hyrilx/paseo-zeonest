import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectRoot } from "../tools/features.mjs";
import { checkBundles } from "../tools/check-bundles.mjs";

test("clean source preparation and a dependency-free packed install use the same manifest safely", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "zeonest-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ["package.json", "package-lock.json", "paseo-plugin.json", "README.md", "OVERVIEW.md", "tools", "shell", "features", "tsconfig.json", "index.client.tsx", "index.server.ts"]) {
    await cp(path.join(projectRoot, file), path.join(root, file), { recursive: true });
  }
  const manifest = JSON.parse(await readFile(path.join(root, "paseo-plugin.json"), "utf8"));
  const env = { ...process.env, NODE_TEST_CONTEXT: undefined, npm_config_offline: "true" };
  // This invokes the real source branch: npm ci --include=dev --ignore-scripts, then build.
  for (const [binary, ...args] of manifest.build) execFileSync(binary, args, { cwd: root, env, stdio: "pipe" });
  await checkBundles(root);
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json"], { cwd: root, env, encoding: "utf8" }))[0];
  assert.deepEqual(packed.files.map((file: { path: string }) => file.path).sort(), [
    "OVERVIEW.md", "README.md", "client/bundle.d.ts", "client/bundle.js", "index.client.tsx", "index.server.ts",
    "package.json", "paseo-plugin.json", "server/bundle.d.ts", "server/bundle.js", "tools/prepare.mjs",
  ].sort());
  execFileSync("tar", ["-xzf", path.join(root, packed.filename), "-C", root]);
  const unpacked = path.join(root, "package");
  assert.equal((await readdir(unpacked)).includes("node_modules"), false);
  assert.equal((await readdir(unpacked)).includes("shell"), false);
  // The prebuilt branch must not invoke npm or call source-only tools/lifecycle scripts.
  const runtimeManifest = JSON.parse(await readFile(path.join(unpacked, "paseo-plugin.json"), "utf8"));
  for (const [binary, ...args] of runtimeManifest.build) {
    const output = execFileSync(binary, args, { cwd: unpacked, env, encoding: "utf8" });
    assert.match(output, /no dependency installation required/);
  }
  const runtimePackage = JSON.parse(await readFile(path.join(unpacked, "package.json"), "utf8"));
  assert.equal(runtimePackage.scripts.prepack, "node tools/prepare.mjs");
  execFileSync(process.execPath, ["tools/prepare.mjs"], { cwd: unpacked, env: { ...env, PATH: "" }, stdio: "pipe" });
  await checkBundles(unpacked);
  await rm(path.join(unpacked, "server/bundle.js"));
  assert.throws(() => execFileSync(process.execPath, ["tools/prepare.mjs"], { cwd: unpacked, env, stdio: "pipe" }), /Command failed/);
});
