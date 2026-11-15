import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiSettingsService } from "../server/service";

// Optional real Pi contract test. It uses a localhost npm registry and an isolated agent directory only.
// ZEONEST_PI_CLI=/absolute/path/to/pi/dist/cli.js node --import tsx --test .../package-cli.test.ts
const cli = process.env.ZEONEST_PI_CLI;
test("real Pi CLI install/update/remove stages npm artifacts without scripts or extension evaluation", { skip: !cli ? "Set ZEONEST_PI_CLI to test the installed Pi CLI against a localhost fixture registry" : false }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-cli-contract-"));
  const agent = join(root, "agent"); const project = join(root, "project"); mkdirSync(agent); mkdirSync(project);
  const filename = execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", root], { cwd: new URL("./fixtures/package", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const tarball = readFileSync(join(root, filename)); let origin = "";
  const name = "zeonest-pi-settings-test-fixture";
  const registry = createServer((req, res) => {
    if (req.url?.endsWith(".tgz")) { res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(tarball); return; }
    if (req.url?.includes("/-/npm/v1/security")) { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name, "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { name, version: "1.0.0", dist: { tarball: `${origin}/fixture.tgz` } } } }));
  });
  await new Promise<void>((done) => registry.listen(0, "127.0.0.1", done));
  const address = registry.address(); assert.ok(address && typeof address !== "string"); origin = `http://127.0.0.1:${address.port}`;
  const service = new PiSettingsService({ agentDir: agent, home: root, workspaceDirectory: async () => project,
    runner: async (_executable, args, options) => {
      try { await promisify(execFile)(process.execPath, [cli!, ...args], { cwd: options.cwd, env: { ...options.env, npm_config_registry: origin, npm_config_cache: join(root, "npm-cache") }, signal: options.signal }); }
      catch (error) {
        const logs = join(root, "npm-cache", "_logs");
        const debug = existsSync(logs) ? readdirSync(logs).filter((file) => file.endsWith(".log")).map((file) => readFileSync(join(logs, file), "utf8")).join("\n") : "";
        throw new Error(`Fixture-only CLI failure (${args[0]}): ${(error as { stdout?: string; stderr?: string }).stdout ?? ""}\n${(error as { stderr?: string }).stderr ?? ""}\n${debug}`);
      }
    },
  });
  t.after(() => { service.dispose(); registry.closeAllConnections(); registry.close(); rmSync(root, { recursive: true, force: true }); });
  const source = `npm:${name}`;
  async function prepare(action: "install" | "update" | "remove") {
    const snapshot = await service.snapshot({});
    return service.preparePackage({}, { source, action, revision: snapshot.documents.find((d) => d.kind === "settings")!.revision, preferencesRevision: snapshot.documents.find((d) => d.kind === "preferences")!.revision });
  }
  const plan = await prepare("install"); assert.equal(existsSync(join(agent, "npm")), false);
  await service.commit(plan.token, true);
  const installed = join(agent, "npm", "node_modules", name, "package.json"); assert.ok(existsSync(installed));
  const update = await prepare("update"); service.discard(update.token); assert.ok(existsSync(installed));
  const remove = await prepare("remove"); assert.ok(existsSync(installed)); await service.commit(remove.token, true); assert.equal(existsSync(installed), false);
});
