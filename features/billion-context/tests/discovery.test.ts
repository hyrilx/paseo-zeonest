import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverOrigins, inlineOrigins, localOrigin, MAX_CANDIDATES } from "../server/discovery";

const signal = () => new AbortController().signal;
const origin = (port: number) => `http://127.0.0.1:${port}`;
const record = (port: number, extra = {}) => JSON.stringify({ origin: origin(port), pid: 42, ...extra });
async function directory(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "zeonest-billion-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("automatic candidates allow only explicit loopback HTTP origins; inline markers are exact", () => {
  assert.equal(localOrigin("http://localhost:1234"), origin(1234));
  assert.equal(localOrigin("http://[::1]:4321"), "http://[::1]:4321");
  for (const value of [null, {}, "https://127.0.0.1:1", "http://remote.test:1", "http://127.0.0.1.evil.test", "http://127.1:1", "http://u:p@localhost", "http://localhost:0", "http://localhost:65536", "http://localhost/path", "http://localhost?x", "file:///tmp/x"]) {
    assert.equal(localOrigin(value), undefined, String(value));
  }
  assert.deepEqual(inlineOrigins([
    "[inline] web UI listening on http://127.0.0.1:1234 (loopback only)",
    "web UI listening on http://127.0.0.1:9999 (loopback only)",
    "[inline] web UI listening on http://remote.test:1111 (loopback only)",
    "[inline] web UI listening on http://127.0.0.1:4321 (loopback only)",
  ].join("\n")), [origin(4321), origin(1234)]);
});

test("discovers proxy, inline, per-instance and legacy records, deduplicating and rejecting stale/foreign records", async (t) => {
  const root = await directory(t); await mkdir(join(root, "instances"));
  await writeFile(join(root, "proxy-origin"), record(8787));
  await writeFile(join(root, "bili.log"), [9001, 9003].map((port) => `[inline] web UI listening on ${origin(port)} (loopback only)`).join("\n"));
  for (const [name, value] of Object.entries({
    a: record(9001, { origin: "http://localhost:9001" }), dead: record(9004, { pid: 43 }),
    released: record(9005, { portReleasedAt: "now" }), invalid: "not json",
    foreign: record(9006, { origin: "http://remote.test:9006" }), nopid: JSON.stringify({ origin: origin(9007) }),
  })) await writeFile(join(root, "instances", name + ".json"), value);
  await writeFile(join(root, "instances.json"), JSON.stringify({ instances: [
    { pid: 42, origin: "http://[::1]:9002", portReleasedAt: null }, { pid: 0, origin: origin(9008) },
  ] }));
  assert.deepEqual(await discoverOrigins(signal(), root, (pid) => pid === 42), [origin(8787), origin(9001), "http://[::1]:9002", origin(9003)]);
});

test("legacy raw proxy origin is accepted but still restricted to loopback; process liveness uses signal zero", async (t) => {
  const root = await directory(t);
  await writeFile(join(root, "proxy-origin"), `  ${origin(8787)}\n`);
  assert.deepEqual(await discoverOrigins(signal(), root), [origin(8787)]);
  await writeFile(join(root, "proxy-origin"), record(8787, { pid: process.pid }));
  assert.deepEqual(await discoverOrigins(signal(), root), [origin(8787)]);
  await writeFile(join(root, "proxy-origin"), "http://remote.test:8787");
  assert.deepEqual(await discoverOrigins(signal(), root), []);
});

test("missing, malformed, oversized or non-regular records are ignored and cancellation rejects", async (t) => {
  const root = await directory(t);
  assert.deepEqual(await discoverOrigins(signal(), join(root, "missing")), []);
  await mkdir(join(root, "bili.log"));
  await writeFile(join(root, "proxy-origin"), record(8787) + " ".repeat(32768));
  await writeFile(join(root, "instances.json"), "{bad json}");
  assert.deepEqual(await discoverOrigins(signal(), root, () => true), []);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(discoverOrigins(controller.signal, root), /已停止/);
});

test("discovery does not follow file symlinks or a symlinked instances directory", async (t) => {
  const root = await directory(t), outside = await directory(t);
  await writeFile(join(outside, "record"), record(8787));
  await writeFile(join(outside, "log"), `[inline] web UI listening on ${origin(9001)} (loopback only)`);
  await mkdir(join(outside, "instances"));
  await writeFile(join(outside, "instances", "a.json"), record(9002));
  await symlink(join(outside, "record"), join(root, "proxy-origin"));
  await symlink(join(outside, "log"), join(root, "bili.log"));
  await symlink(join(outside, "instances"), join(root, "instances"));
  assert.deepEqual(await discoverOrigins(signal(), root, () => true), []);
});

test("log reads are limited to the last 512 KiB and discard a partial first line", async (t) => {
  const root = await directory(t);
  await writeFile(join(root, "bili.log"), `[inline] web UI listening on ${origin(9001)} (loopback only)\n`
    + "x".repeat(524288) + `\n[inline] web UI listening on ${origin(9002)} (loopback only)\n`);
  assert.deepEqual(await discoverOrigins(signal(), root), [origin(9002)]);
});

test("candidate and registry limits remain bounded even with many stale entries", async (t) => {
  const root = await directory(t);
  await writeFile(join(root, "bili.log"), Array.from({ length: MAX_CANDIDATES + 40 }, (_, index) =>
    `[inline] web UI listening on ${origin(9000 + index)} (loopback only)`).join("\n"));
  const found = await discoverOrigins(signal(), root);
  assert.equal(found.length, MAX_CANDIDATES);
  assert.equal(found[0], origin(9000 + MAX_CANDIDATES + 39));
  assert.ok(found.length > 16, "history must not be truncated to the UI choice count");
  // Live PID-backed registry entries take precedence over a crowded history tail.
  await writeFile(join(root, "proxy-origin"), record(8787));
  assert.equal((await discoverOrigins(signal(), root, () => true))[0], origin(8787));
  await writeFile(join(root, "bili.log"), ""); await writeFile(join(root, "proxy-origin"), ""); await mkdir(join(root, "instances"));
  await Promise.all(Array.from({ length: 65 }, (_, index) => writeFile(join(root, "instances", `${String(index).padStart(3, "0")}.json`), index === 64 ? record(9999) : "invalid")));
  assert.deepEqual(await discoverOrigins(signal(), root, () => true), []);
});

test("default state directory follows XDG_STATE_HOME", async (t) => {
  const root = await directory(t), previous = process.env.XDG_STATE_HOME;
  await mkdir(join(root, "billion-context"));
  await writeFile(join(root, "billion-context", "proxy-origin"), origin(8787));
  try {
    process.env.XDG_STATE_HOME = root;
    assert.deepEqual(await discoverOrigins(signal()), [origin(8787)]);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous;
  }
});
