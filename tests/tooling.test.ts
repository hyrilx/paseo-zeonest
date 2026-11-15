import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadFeatures, projectRoot, syncFeatures, validateMetadata } from "../tools/features.mjs";
import { createFeature } from "../tools/new-feature.mjs";
import { checkBundles } from "../tools/check-bundles.mjs";

const metadata = (id = "alpha") => ({
  id, name: "Feature " + id, description: "Test feature", version: "0.1.0", tags: ["test"], author: "test",
});

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(tmpdir(), "zeonest-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const item of ["client", "server", "shared", "index.client.tsx", "index.server.ts", "tsconfig.json"]) {
    await cp(path.join(projectRoot, item), path.join(root, item), { recursive: true });
  }
  await symlink(path.join(projectRoot, "node_modules"), path.join(root, "node_modules"), "dir");
  await mkdir(path.join(root, "features"));
  return root;
}

test("metadata validates identifiers, required fields, SemVer and tags", () => {
  assert.deepEqual(validateMetadata(metadata(), "alpha"), metadata());
  for (const patch of [
    { id: "../escape" }, { id: "zeonest" }, { name: "" }, { author: " " },
    { version: "1.0" }, { version: "01.0.0" }, { tags: ["test", "test"] }, { tags: [3] },
  ]) {
    const value = { ...metadata(), ...patch };
    assert.throws(() => validateMetadata(value, value.id));
  }
  assert.equal(validateMetadata({ ...metadata(), version: "1.2.3-beta.1+build.4" }, "alpha").version, "1.2.3-beta.1+build.4");
});

for (const runtime of ["client", "server", "both"]) {
  test(runtime + " scaffold with settings generates valid native entries and static bundles", async (t) => {
    const root = await fixture(t);
    await createFeature(root, metadata(), runtime, true);
    const [feature] = await loadFeatures(root);
    assert.ok(feature);
    assert.equal(Boolean(feature.client), runtime !== "server");
    assert.equal(Boolean(feature.server), runtime !== "client");
    assert.ok(feature.clientSettings);
    assert.ok(feature.serverSettings);
    assert.deepEqual(await syncFeatures(root, true), []);
    await checkBundles(root);
    execFileSync(process.execPath, [
      path.join(projectRoot, "node_modules/typescript/bin/tsc"), "--project", path.join(root, "tsconfig.json"), "--noEmit",
    ], { cwd: root, stdio: "pipe" });
  });
}

test("no-settings scaffold stays minimal and refuses overwrites", async (t) => {
  const root = await fixture(t);
  await createFeature(root, metadata(), "client", false);
  const [feature] = await loadFeatures(root);
  assert.ok(feature);
  assert.equal(feature.clientSettings, undefined);
  const original = await readFile(path.join(root, "client/features/alpha/index.ts"), "utf8");
  await assert.rejects(createFeature(root, metadata(), "client", false), /already exists/);
  assert.equal(await readFile(path.join(root, "client/features/alpha/index.ts"), "utf8"), original);
});

test("check mode detects stale manifests without modifying them", async (t) => {
  const root = await fixture(t);
  await createFeature(root, metadata(), "both", false);
  const before = await readFile(path.join(root, "shared/catalog.generated.ts"), "utf8");
  await writeFile(path.join(root, "features/alpha/feature.json"), JSON.stringify({ ...metadata(), name: "Changed" }));
  await assert.rejects(syncFeatures(root, true), /Stale generated manifests/);
  assert.equal(await readFile(path.join(root, "shared/catalog.generated.ts"), "utf8"), before);
  await syncFeatures(root);
  assert.match(await readFile(path.join(root, "shared/catalog.generated.ts"), "utf8"), /Changed/);
});

test("ambiguous entries and unlisted runtime directories are rejected", async (t) => {
  const root = await fixture(t);
  await createFeature(root, metadata(), "client", false);
  await writeFile(path.join(root, "client/features/alpha/index.tsx"), "export default () => () => {};");
  await assert.rejects(loadFeatures(root), /Ambiguous/);
  await rm(path.join(root, "client/features/alpha/index.tsx"));
  await mkdir(path.join(root, "server/features/orphan"), { recursive: true });
  await assert.rejects(loadFeatures(root), /Missing features\/orphan/);
});

test("bundle check rejects cross-runtime imports and Node modules on the client", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "client/bad.ts"), 'import "../server/shell";');
  await writeFile(path.join(root, "index.client.tsx"), 'import "./client/bad";');
  await assert.rejects(checkBundles(root), /invalid runtime module/);
  await writeFile(path.join(root, "client/bad.ts"), 'import "node:fs";');
  await assert.rejects(checkBundles(root), /not host-provided/);
});

async function integratedServer(root: string, enabled: Record<string, boolean>) {
  const outfile = path.join(root, "test-server.mjs");
  await build({ absWorkingDir: root, entryPoints: ["index.server.ts"], outfile,
    bundle: true, platform: "node", packages: "external", format: "esm", logLevel: "silent" });
  const { default: contribute } = await import(pathToFileURL(outfile).href);
  const handlers = new Map<string, () => unknown>();
  const registered: string[] = [];
  let cleanups = 0;
  const fake = {
    registerSettings: (definition: { id: string }) => {
      registered.push(definition.id);
      return {
        read: async () => ({ status: "ready", revision: "1", values: { enabled } }),
        subscribe: () => () => {},
      };
    },
    handle: (contract: { name: string }, handler: () => unknown) => { handlers.set(contract.name, handler); },
    on: () => () => { cleanups++; },
  } as unknown as PluginServerContext;
  const cleanup = contribute(fake);
  const snapshot = await handlers.get("zeonest.shell.runtime")!();
  return { cleanup, snapshot, registered, handlers, cleanups: () => cleanups };
}

function serverEntry(id: string) {
  return `import type { PluginServerContext } from "@getpaseo/plugin/server";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export default function contribute(server: PluginServerContext) {
  server.handle(defineRpc({ name: "${id}.ping", input: z.object({}), output: z.object({}) }), () => ({}));
  return server.on("agent.turn_ended", () => {});
}
`;
}

test("static integration starts enabled behavior only, keeps disabled settings and fixes snapshot", async (t) => {
  const root = await fixture(t);
  for (const id of ["alpha", "beta"]) {
    await createFeature(root, metadata(id), "server", true);
    await writeFile(path.join(root, "server/features", id, "index.ts"), serverEntry(id));
  }
  const enabled = { alpha: true, beta: false };
  const server = await integratedServer(root, enabled);
  assert.deepEqual(server.snapshot, { enabledIds: ["alpha"], error: null });
  assert.ok(server.handlers.has("alpha.ping"));
  assert.equal(server.handlers.has("beta.ping"), false);
  assert.deepEqual(server.registered, ["zeonest-shell", "alpha-preferences", "beta-preferences"]);
  enabled.alpha = false;
  enabled.beta = true;
  assert.deepEqual(await server.handlers.get("zeonest.shell.runtime")!(), server.snapshot);
  await server.cleanup();
  await server.cleanup();
  assert.equal(server.cleanups(), 1);
});

test("startup failure is reported and cleans already started native contributions", async (t) => {
  const root = await fixture(t);
  for (const id of ["alpha", "beta"]) await createFeature(root, metadata(id), "server", false);
  await writeFile(path.join(root, "server/features/alpha/index.ts"), serverEntry("alpha"));
  await writeFile(path.join(root, "server/features/beta/index.ts"), 'export default function contribute() { throw new Error("startup failed"); }');
  const original = console.error;
  console.error = () => {};
  try {
    const server = await integratedServer(root, { alpha: true, beta: true });
    assert.deepEqual(server.snapshot, { enabledIds: [], error: "startup failed" });
    assert.equal(server.cleanups(), 1);
    await server.cleanup();
    assert.equal(server.cleanups(), 1);
  } finally { console.error = original; }
});
