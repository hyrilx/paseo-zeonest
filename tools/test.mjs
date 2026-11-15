import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot } from "./features.mjs";

/** Fixtures and helper files never become tests just because they contain .test.ts. */
export async function discoverTests(root = projectRoot) {
  const files = [];
  async function walk(directory, insideTests = false) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || ["fixtures", "node_modules"].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file, insideTests || entry.name === "tests");
      else if (entry.isFile() && insideTests && /\.test\.[cm]?[jt]sx?$/.test(entry.name)) files.push(file);
    }
  }
  await walk(path.join(root, "tests"), true);
  await walk(path.join(root, "features"));
  return files.sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const files = await discoverTests();
    if (!files.length) throw new Error("No tests discovered");
    const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { cwd: projectRoot, stdio: "inherit" });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
