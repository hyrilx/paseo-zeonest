import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadFeatures, projectRoot, validateMetadata } from "../tools/features.mjs";
import { createFeature } from "../tools/new-feature.mjs";
import { checkBundles } from "../tools/check-bundles.mjs";
import { buildPlugin } from "../tools/build.mjs";
import { typecheck } from "../tools/typecheck.mjs";
import { discoverTests } from "../tools/test.mjs";
import { createSourceChecker } from "../tools/boundaries.mjs";

const metadata = (id = "alpha") => ({
  id, name: "Feature " + id, description: "Test feature", version: "0.1.0", tags: ["test"], author: "test",
});

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(tmpdir(), "zeonest-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const item of ["shell", "index.client.tsx", "index.server.ts", "tsconfig.json"]) {
    await cp(path.join(projectRoot, item), path.join(root, item), { recursive: true });
  }
  await symlink(path.join(projectRoot, "node_modules"), path.join(root, "node_modules"), "dir");
  await mkdir(path.join(root, "features"));
  return root;
}

async function put(root: string, file: string, content: string) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}

test("metadata validates all six fields, identifiers, SemVer, tags and rejects extras", () => {
  assert.deepEqual(validateMetadata(metadata(), "alpha"), metadata());
  for (const patch of [
    { id: "../escape" }, { id: "zeonest" }, { name: "" }, { description: "" }, { author: " " },
    { version: "1.0" }, { version: "01.0.0" }, { tags: ["test", "test"] }, { tags: [3] }, { enabled: true },
  ]) {
    const value = { ...metadata(), ...patch };
    assert.throws(() => validateMetadata(value, value.id));
  }
  for (const field of Object.keys(metadata())) {
    const value: Record<string, unknown> = { ...metadata() };
    delete value[field];
    assert.throws(() => validateMetadata(value, "alpha"));
  }
  assert.throws(() => validateMetadata(metadata(), "different"), /match/);
  assert.equal(validateMetadata({ ...metadata(), version: "1.2.3-beta.1+build.4" }, "alpha").version, "1.2.3-beta.1+build.4");
});

test("empty feature set builds stable native-only graphs without committed manifests", async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await loadFeatures(root), []);
  await buildPlugin(root);
  await checkBundles(root);
  const before = await readFile(path.join(root, "client/bundle.js"), "utf8");
  await buildPlugin(root);
  assert.equal(await readFile(path.join(root, "client/bundle.js"), "utf8"), before);
  assert.deepEqual((await readdir(path.join(root, "client"))).sort(), ["bundle.d.ts", "bundle.js"]);
  assert.doesNotMatch(before, /\.\.\/|features\/|shell\//);
});

for (const runtime of ["client", "server", "both"]) {
  test(runtime + " scaffold touches only its feature and produces typed native entries with independent settings", async (t) => {
    const root = await fixture(t);
    const files = await createFeature(root, metadata(), runtime, true);
    assert.ok(files.every((file: string) => file.startsWith("features/alpha/")));
    const [feature] = await loadFeatures(root);
    assert.ok(feature);
    assert.equal(Boolean(feature.client), runtime !== "server");
    assert.equal(Boolean(feature.server), runtime !== "client");
    assert.ok(feature.clientSettings);
    assert.ok(feature.serverSettings);
    await typecheck(root, false);
    await buildPlugin(root);
    await checkBundles(root);
  });
}

test("no-settings scaffold stays minimal and refuses overwrites", async (t) => {
  const root = await fixture(t);
  await createFeature(root, metadata(), "client", false);
  const [feature] = await loadFeatures(root);
  assert.ok(feature);
  assert.equal(feature.clientSettings, undefined);
  const original = await readFile(path.join(root, "features/alpha/client/index.ts"), "utf8");
  await assert.rejects(createFeature(root, metadata(), "client", false), /already exists/);
  assert.equal(await readFile(path.join(root, "features/alpha/client/index.ts"), "utf8"), original);
  assert.deepEqual((await readdir(path.join(root, "features/alpha"))).sort(), ["README.md", "client", "feature.json"]);
});

test("build discovers changed metadata and entries without any synchronization step", async (t) => {
  const root = await fixture(t);
  await createFeature(root, metadata("zeta"), "client", false);
  await createFeature(root, metadata(), "server", false);
  assert.deepEqual((await loadFeatures(root)).map((feature) => feature.metadata.id), ["alpha", "zeta"]);
  await buildPlugin(root);
  await put(root, "features/alpha/feature.json", JSON.stringify({ ...metadata(), name: "Changed metadata" }));
  await buildPlugin(root);
  assert.match(await readFile(path.join(root, "client/bundle.js"), "utf8"), /Changed metadata/);
  await rm(path.join(root, "features/alpha"), { recursive: true });
  await buildPlugin(root);
  assert.doesNotMatch(await readFile(path.join(root, "client/bundle.js"), "utf8"), /Changed metadata/);
});

test("entry ambiguity, absent business entry, invalid metadata and orphan directories fail discovery", async (t) => {
  const root = await fixture(t);
  await createFeature(root, metadata(), "client", false);
  await put(root, "features/alpha/client/index.tsx", "export default () => () => {};");
  await assert.rejects(loadFeatures(root), /Ambiguous/);
  await rm(path.join(root, "features/alpha/client/index.tsx"));
  await rm(path.join(root, "features/alpha/client/index.ts"));
  await assert.rejects(loadFeatures(root), /needs a client or server/);
  await put(root, "features/alpha/client/index.ts", "export default () => () => {};");
  await put(root, "features/alpha/feature.json", "{invalid");
  await assert.rejects(loadFeatures(root), /feature.json/);
  await put(root, "features/alpha/feature.json", JSON.stringify(metadata()));
  await mkdir(path.join(root, "features/orphan"));
  await assert.rejects(loadFeatures(root), /Missing features\/orphan/);
});

test("ephemeral native contribution tables are typechecked, not just transpiled", async (t) => {
  const root = await fixture(t);
  await createFeature(root, metadata(), "client", true);
  await put(root, "features/alpha/client/index.ts", 'export default function contribute(value: number) { return value; }');
  await assert.rejects(typecheck(root, false), /PluginClientContribution/);
  await put(root, "features/alpha/client/index.ts", 'export default () => () => {};');
  await put(root, "features/alpha/client/settings.tsx", 'export default { id: "bad" };');
  await assert.rejects(typecheck(root, false), /PluginSettingsScreenContribution/);
});

const badImports = [
  ["client", 'import "../server/helper";', "server/helper.ts", "export const value = 1;"],
  ["client", 'import type { Value } from "../server/helper";', "server/helper.ts", "export type Value = string;"],
  ["client", 'export type Value = import("../server/helper").Value;', "server/helper.ts", "export type Value = string;"],
  ["client", 'import "node:fs";', "shared/helper.ts", "export {};"],
  ["client", 'import type { Stats } from "fs";', "shared/helper.ts", "export {};"],
  ["client", 'import type { PluginServerContext } from "@getpaseo/plugin/server";', "shared/helper.ts", "export {};"],
  ["server", 'import type { ReactNode } from "react";', "shared/helper.ts", "export {};"],
  ["server", 'import "@getpaseo/plugin/client/ui";', "shared/helper.ts", "export {};"],
  ["client", 'import "@getpaseo/plugin/client/host";', "shared/helper.ts", "export {};"],
  ["server", 'import type { X } from "@getpaseo/plugin/unknown";', "shared/helper.ts", "export {};"],
  ["client", 'import type { Value } from "../shared/helper";', "shared/helper.ts", 'export type { Value } from "../server/secret";'],
  ["client", 'import "../shared/helper";', "shared/helper.ts", 'import type { ReactNode } from "react";'],
  ["server", 'import "../shared/helper";', "shared/helper.ts", 'import "node:path";'],
  ["client", 'import "../tests/helper";', "tests/helper.ts", "export {};"],
  ["client", 'import "../../../shell/shared/lifetime";', "shared/helper.ts", "export {};"],
  ["client", 'import "../../beta/shared/helper";', "shared/helper.ts", "export {};"],
  ["server", '/// <reference types="react" />\n', "shared/helper.ts", "export {};"],
  ["client", '/// <reference types="node" />\n', "shared/helper.ts", "export {};"],
  ["client", '/// <reference lib="dom" />\n', "shared/helper.ts", "export {};"],
  ["client", 'const file = "node:fs"; import(file);', "shared/helper.ts", "export {};"],
  ["client", 'import { z } from "zod/v4";', "shared/helper.ts", "export {};"],
  ["client", 'import "react-dom";', "shared/helper.ts", "export {};"],
] as const;
for (const [index, [runtime, code, helper, body]] of badImports.entries()) {
  test(`source boundary rejects case ${index + 1}: ${runtime} ${code}`, async (t) => {
    const root = await fixture(t);
    await createFeature(root, metadata(), runtime, false);
    await put(root, "features/alpha/" + helper, body);
    await put(root, "features/alpha/server/secret.ts", "export type Value = string;");
    await put(root, "features/alpha/" + runtime + "/index.ts", code + "\nexport default () => () => {};");
    await assert.rejects(buildPlugin(root), /dependency|SDK|Cross-|Invalid|Non-static|DOM/);
  });
}

test("same-feature shared imports and server Node imports are valid; outputs contain no opposite-side sentinel", async (t) => {
  const root = await fixture(t);
  await createFeature(root, metadata(), "both", false);
  await put(root, "features/alpha/shared/helper.ts", 'export type Value = string; export const value = "SHARED_SENTINEL";');
  await put(root, "features/alpha/client/index.ts", 'import { value, type Value } from "../shared/helper"; export default () => { console.log("CLIENT_SENTINEL", value); return () => {}; };');
  await put(root, "features/alpha/server/index.ts", 'import { basename } from "node:path"; import { value } from "../shared/helper"; export default () => { console.log("SERVER_SENTINEL", basename(value)); return () => {}; };');
  await buildPlugin(root);
  await checkBundles(root);
  const client = await readFile(path.join(root, "client/bundle.js"), "utf8");
  const server = await readFile(path.join(root, "server/bundle.js"), "utf8");
  assert.match(client, /CLIENT_SENTINEL/); assert.match(client, /SHARED_SENTINEL/);
  assert.doesNotMatch(client, /SERVER_SENTINEL|node:path/);
  assert.match(server, /SERVER_SENTINEL/); assert.doesNotMatch(server, /CLIENT_SENTINEL|react-native/);
});

test("declared local and shared SVG assets typecheck and embed as text in only their runtime bundles", async (t) => {
  const root = await fixture(t);
  await createFeature(root, metadata(), "both", false);
  await put(root, "features/alpha/shared/assets.d.ts", 'declare module "*.svg" { const value: string; export default value; }');
  await put(root, "features/alpha/shared/icon.svg", '<svg xmlns="http://www.w3.org/2000/svg" id="SVG_SHARED"/>');
  await put(root, "features/alpha/shared/image.ts", 'import icon from "./icon.svg"; export { icon };');
  for (const runtime of ["client", "server"]) {
    await put(root, `features/alpha/${runtime}/icon.svg`, `<svg xmlns="http://www.w3.org/2000/svg" id="SVG_LOCAL_${runtime.toUpperCase()}"/>`);
    await put(root, `features/alpha/${runtime}/index.ts`, 'import icon from "./icon.svg"; import { icon as shared } from "../shared/image"; export default () => { console.log(icon, shared); return () => {}; };');
  }
  await typecheck(root, false);
  await buildPlugin(root);
  await checkBundles(root);
  for (const runtime of ["client", "server"]) {
    const output = await readFile(path.join(root, runtime, "bundle.js"), "utf8");
    assert.match(output, new RegExp("SVG_LOCAL_" + runtime.toUpperCase()));
    assert.match(output, /SVG_SHARED/);
    assert.doesNotMatch(output, new RegExp("SVG_LOCAL_" + (runtime === "client" ? "SERVER" : "CLIENT")));
    assert.doesNotMatch(output, /from[" ]+[^;]*\.svg/);
  }
  await rm(path.join(root, "features/alpha/shared/assets.d.ts"));
  await assert.rejects(typecheck(root, false), /Cannot find module/);
});

for (const [runtime, imported, asset, expected] of [
  ["client", "../server/icon.svg", "features/alpha/server/icon.svg", /Cross-runtime/],
  ["server", "../client/icon.svg", "features/alpha/client/icon.svg", /Cross-runtime/],
  ["client", "../../beta/shared/icon.svg", "features/beta/shared/icon.svg", /Cross-feature/],
  ["client", "../../../shell/client/icon.svg", "shell/client/icon.svg", /Cross-feature/],
  ["client", "../tests/icon.svg", "features/alpha/tests/icon.svg", /Invalid runtime source/],
  ["client", "../../../tools/icon.svg", "tools/icon.svg", /Invalid runtime source/],
  ["shared", "../client/icon.svg", "features/alpha/client/icon.svg", /Cross-runtime/],
] as const) {
  test(`SVG imports retain source boundaries: ${runtime} -> ${imported}`, async (t) => {
    const root = await fixture(t);
    await createFeature(root, metadata(), runtime === "shared" ? "client" : runtime, false);
    if (asset.startsWith("features/beta/")) await createFeature(root, metadata("beta"), "client", false);
    await put(root, "features/alpha/shared/assets.d.ts", 'declare module "*.svg" { const value: string; export default value; }');
    await put(root, asset, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const code = `import icon from ${JSON.stringify(imported)}; export default () => { console.log(icon); return () => {}; };`;
    await put(root, `features/alpha/${runtime}/index.ts`, code);
    await assert.rejects(buildPlugin(root), expected);
  });
}

test("SVG support does not permit missing assets, SVG directories or arbitrary unresolved extensions", async (t) => {
  const root = await fixture(t);
  await createFeature(root, metadata(), "client", false);
  await put(root, "features/alpha/client/assets.d.ts", 'declare module "*.svg" { const value: string; export default value; }');
  await put(root, "features/alpha/client/note.txt", "Not a supported static import");
  await mkdir(path.join(root, "features/alpha/client/directory.svg"));
  for (const asset of ["missing.svg", "directory.svg", "note.txt"]) {
    await put(root, "features/alpha/client/index.ts", `import icon from "./${asset}"; export default () => { console.log(icon); return () => {}; };`);
    await assert.rejects(buildPlugin(root), /Unresolved source dependency/);
  }
});

test("SVG checks retain both authored and real-path ownership before embedding", async (t) => {
  const root = await fixture(t);
  await createFeature(root, metadata(), "client", false);
  await put(root, "features/alpha/shared/icon.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await put(root, "features/alpha/server/icon.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await put(root, "features/alpha/client/index.ts", 'import icon from "../server/alias.svg"; export default () => { console.log(icon); return () => {}; };');
  await symlink("../shared/icon.svg", path.join(root, "features/alpha/server/alias.svg"));
  assert.throws(() => createSourceChecker(root)(path.join(root, "features/alpha/client/index.ts"), "client"), /Cross-runtime/);
  await put(root, "features/alpha/client/index.ts", 'import icon from "./alias.svg"; export default () => { console.log(icon); return () => {}; };');
  await symlink("../server/icon.svg", path.join(root, "features/alpha/client/alias.svg"));
  assert.throws(() => createSourceChecker(root)(path.join(root, "features/alpha/client/index.ts"), "client"), /Cross-runtime/);
  await assert.rejects(buildPlugin(root), /symlink/);
});

test("business tools subdirectories are valid within client, server and shared source", async (t) => {
  const root = await fixture(t);
  await createFeature(root, metadata(), "both", false);
  await put(root, "features/alpha/shared/tools/helper.ts", 'export const value = "SHARED_TOOL_IMPLEMENTATION";');
  for (const runtime of ["client", "server"]) {
    await put(root, `features/alpha/${runtime}/tools/helper.ts`, `export const value = "${runtime.toUpperCase()}_TOOL_IMPLEMENTATION";`);
    await put(root, `features/alpha/${runtime}/index.ts`, 'import { value } from "./tools/helper"; import { value as shared } from "../shared/tools/helper"; export default () => { console.log(value, shared); return () => {}; };');
  }
  await typecheck(root, false);
  await buildPlugin(root);
  await checkBundles(root);
  for (const runtime of ["client", "server"]) {
    const output = await readFile(path.join(root, runtime, "bundle.js"), "utf8");
    assert.match(output, new RegExp(runtime.toUpperCase() + "_TOOL_IMPLEMENTATION"));
    assert.match(output, /SHARED_TOOL_IMPLEMENTATION/);
  }
});

for (const [imported, target, expected] of [
  ["../../../../tools/helper", "tools/helper.ts", /Invalid runtime source/],
  ["../../tests/helper", "features/alpha/tests/helper.ts", /Invalid runtime source/],
  ["../../client/helper", "features/alpha/client/helper.ts", /Cross-runtime/],
] as const) {
  test(`business tools helpers cannot import non-owned modules: ${imported}`, async (t) => {
    const root = await fixture(t);
    await createFeature(root, metadata(), "server", false);
    await put(root, target, 'export const value = "forbidden";');
    await put(root, "features/alpha/server/tools/helper.ts", `export { value } from ${JSON.stringify(imported)};`);
    await put(root, "features/alpha/server/index.ts", 'import { value } from "./tools/helper"; export default () => { console.log(value); return () => {}; };');
    await assert.rejects(buildPlugin(root), expected);
  });
}

test("a feature named shell still cannot depend on shell internals", async (t) => {
  const root = await fixture(t);
  await createFeature(root, metadata("shell"), "client", false);
  await put(root, "features/shell/client/index.ts", 'import "../../../shell/shared/lifetime"; export default () => () => {};');
  await assert.rejects(buildPlugin(root), /Cross-feature/);
});

test("runtime directory symlinks cannot masquerade as another side", async (t) => {
  const root = await fixture(t);
  await createFeature(root, metadata(), "client", false);
  await rm(path.join(root, "features/alpha/client"), { recursive: true });
  await put(root, "features/alpha/server/index.ts", "export default () => () => {};");
  await symlink("server", path.join(root, "features/alpha/client"));
  await assert.rejects(buildPlugin(root), /symlink/);
});

test("source symlinks cannot hide server types in a shared directory", async (t) => {
  const root = await fixture(t);
  await createFeature(root, metadata(), "client", false);
  await put(root, "features/alpha/server/helper.ts", "export type Value = string;");
  await mkdir(path.join(root, "features/alpha/shared"));
  await symlink("../server/helper.ts", path.join(root, "features/alpha/shared/helper.ts"));
  await assert.rejects(buildPlugin(root), /symlink/);
});

test("third-party runtime and declaration transitives are checked; server libraries are bundled", async (t) => {
  const root = await fixture(t);
  await rm(path.join(root, "node_modules")); // never write through the shared dependency symlink
  await put(root, "node_modules/tiny/package.json", JSON.stringify({ name: "tiny", type: "module", main: "index.js", types: "index.d.ts" }));
  await put(root, "node_modules/tiny/index.js", 'export const value = "BUNDLED_LIBRARY";');
  await put(root, "node_modules/tiny/index.d.ts", 'export declare const value: string;');
  await createFeature(root, metadata(), "server", false);
  await put(root, "features/alpha/server/index.ts", 'import { value } from "tiny"; export default () => { console.log(value); return () => {}; };');
  await buildPlugin(root);
  await checkBundles(root);
  assert.match(await readFile(path.join(root, "server/bundle.js"), "utf8"), /BUNDLED_LIBRARY/);
  await put(root, "node_modules/tiny/index.d.ts", 'import type { ReactNode } from "react"; export declare const value: string;');
  await assert.rejects(buildPlugin(root), /Client dependency/);
  await put(root, "node_modules/tiny/index.d.ts", 'export declare const value: string;');
  await put(root, "features/alpha/shared/helper.ts", 'export { value } from "tiny";');
  await put(root, "node_modules/tiny/index.js", 'export { basename as value } from "node:path";');
  await assert.rejects(buildPlugin(root), /Node dependency/);
});

test("test discovery recurses through feature tests but excludes fixtures and runtime lookalikes", async (t) => {
  const root = await fixture(t);
  await createFeature(root, metadata(), "client", false);
  const valid = ["tests/root.test.ts", "features/alpha/tests/nested/behavior.test.tsx"];
  for (const file of valid) await put(root, file, 'import test from "node:test"; test("discovered", () => {});');
  await put(root, "features/alpha/tests/fixtures/bad.test.ts", 'throw new Error("fixture executed");');
  await put(root, "features/alpha/client/not-a-test.test.ts", 'throw new Error("runtime executed");');
  const files = await discoverTests(root);
  assert.deepEqual(files, valid.map((file) => path.join(root, file)).sort());
  const output = execFileSync(process.execPath, ["--import", "tsx", "--test", ...files], { cwd: root, encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  assert.match(output, /pass 2/);
});

async function integratedServer(root: string, enabled: Record<string, boolean>) {
  await buildPlugin(root);
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
      return { read: async () => ({ status: "ready", revision: "1", values: { enabled } }), subscribe: () => () => {} };
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
    await put(root, "features/" + id + "/server/index.ts", serverEntry(id));
  }
  const enabled = { alpha: true, beta: false };
  const server = await integratedServer(root, enabled);
  assert.deepEqual(server.snapshot, { enabledIds: ["alpha"], error: null });
  assert.ok(server.handlers.has("alpha.ping"));
  assert.equal(server.handlers.has("beta.ping"), false);
  assert.deepEqual(server.registered, ["zeonest-shell", "alpha-preferences", "beta-preferences"]);
  enabled.alpha = false; enabled.beta = true;
  assert.deepEqual(await server.handlers.get("zeonest.shell.runtime")!(), server.snapshot);
  await server.cleanup(); await server.cleanup();
  assert.equal(server.cleanups(), 1);
});

test("startup failure is reported and cleans already started native contributions", async (t) => {
  const root = await fixture(t);
  for (const id of ["alpha", "beta"]) await createFeature(root, metadata(id), "server", false);
  await put(root, "features/alpha/server/index.ts", serverEntry("alpha"));
  await put(root, "features/beta/server/index.ts", 'export default function contribute() { throw new Error("startup failed"); }');
  const original = console.error;
  console.error = () => {};
  try {
    const server = await integratedServer(root, { alpha: true, beta: true });
    assert.deepEqual(server.snapshot, { enabledIds: [], error: "startup failed" });
    assert.equal(server.cleanups(), 1);
    await server.cleanup(); assert.equal(server.cleanups(), 1);
  } finally { console.error = original; }
});
