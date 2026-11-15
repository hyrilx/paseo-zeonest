// This is the only tool shipped in the prebuilt package. Node builtins only.
import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
async function exists(file) {
  try { await access(path.join(root, file)); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
try {
  if (await exists("shell")) {
    // Local/Git source: Paseo skips npm lifecycle scripts, so prepare explicitly.
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    for (const args of [["ci", "--include=dev", "--ignore-scripts"], ["run", "build"]]) {
      const result = spawnSync(npm, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error("Source preparation failed: npm " + args.join(" "));
    }
  } else {
    // Prebuilt package: no install or missing-source build commands.
    for (const file of ["index.client.tsx", "index.server.ts", "client/bundle.js", "server/bundle.js"]) {
      if (!await exists(file)) throw new Error("Incomplete prebuilt Zeonest package: missing " + file);
    }
    console.log("Prebuilt Zeonest bundles are ready; no dependency installation required.");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
