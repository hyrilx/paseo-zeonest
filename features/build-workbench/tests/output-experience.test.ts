import assert from "node:assert/strict";
import { test } from "node:test";
import { appendOptions, commonOptions } from "../client/common-options";
import { isScrollingAway, outputGroups, pausedRows } from "../client/output-state";
import { parseArguments } from "../shared/arguments";
import type { Log } from "../shared/contracts";
import { cargoOptions, cmakeOptions, gradleOptions, tauriOptions, xcodeOptions } from "../server/options";

const log = (...cursors: number[]): Log[] => cursors.map((cursor) => ({ cursor, text: String(cursor), stream: "stdout" }));

test("output pauses on upward movement away from the tail, not on growth or clamping at the tail", () => {
  assert.equal(isScrollingAway(180, 120, 60), true);
  assert.equal(isScrollingAway(180, 180, 60), false);
  assert.equal(isScrollingAway(180, 160, 0), false);
  assert.equal(isScrollingAway(180, 179.5, 20), false);
});

test("paused output keeps the visible prefix across a refetch or buffer eviction", () => {
  const seen = log(3, 4, 5);
  assert.equal(pausedRows(seen, log(1, 2)), seen);
  assert.deepEqual(pausedRows(seen, log(1, 2, 3, 4, 5, 6)), log(3, 4, 5, 6));
  assert.equal(pausedRows(seen, log(4, 5, 6, 7)), seen);
  assert.deepEqual(pausedRows([], log(1)), log(1));
});

test("stream labels do not insert line breaks inside an RPC chunk sequence", () => {
  const rows = [
    { cursor: 1, stream: "stdout", text: "hel" },
    { cursor: 2, stream: "stdout", text: "lo\n" },
    { cursor: 3, stream: "stderr", text: "warning\n" },
    { cursor: 4, stream: "stdout", text: "again" },
    { cursor: 6, stream: "stdout", text: "later" },
  ] satisfies Log[];
  assert.deepEqual(outputGroups(rows), [{ ...rows[0], text: "hello\n" }, ...rows.slice(2)]);
  assert.equal(rows[0]?.text, "hel");
});

test("applying common flags preserves existing editable text, quotes and whitespace", () => {
  assert.equal(appendOptions("", ["--offline"]), "--offline");
  assert.equal(appendOptions("  --features 'a b'", ["--release", "--locked"]), "  --features 'a b' --release --locked");
  assert.equal(appendOptions("--verbose  ", ["--parallel 4"]), "--verbose  --parallel 4");
  assert.equal(appendOptions("  --info ", []), "  --info ");
});

test("common options match the adapter and operation accepted by the backend", () => {
  const flags = (adapter: Parameters<typeof commonOptions>[0]["adapter"], operation?: "probe") =>
    commonOptions({ adapter, operation }).flatMap(([flag]) => parseArguments(flag));
  assert.deepEqual(flags("cargo"), ["--release", "--locked", "--offline"]);
  assert.doesNotThrow(() => cargoOptions(".", ".", flags("cargo")));
  assert.deepEqual(flags("cmake"), ["--parallel", "4", "--verbose"]);
  assert.doesNotThrow(() => cmakeOptions(flags("cmake"), false));
  assert.doesNotThrow(() => cmakeOptions(flags("cmake", "probe"), true));
  assert.ok(!flags("cmake", "probe").some((flag) => flag.startsWith("-DCMAKE_PREFIX_PATH")));
  assert.deepEqual(flags("gradle", "probe"), flags("gradle"));
  assert.doesNotThrow(() => gradleOptions(flags("gradle", "probe"), true));
  assert.doesNotThrow(() => gradleOptions(flags("gradle"), false));
  assert.doesNotThrow(() => xcodeOptions(flags("xcode", "probe"), true));
  assert.doesNotThrow(() => xcodeOptions(flags("xcode"), false));
  assert.doesNotThrow(() => tauriOptions(".", ".", flags("tauri")));
});
