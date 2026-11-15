import { build } from "esbuild";
import { isBuiltin } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "./features.mjs";
import { checkSpecifier, hostModules } from "./boundaries.mjs";
import { fileURLToPath } from "node:url";

/** Check exactly what Paseo sees: fixed native entries and prebuilt native-directory modules. */
export async function checkBundles(root = projectRoot) {
  for (const runtime of ["client", "server"]) {
    const entry = runtime === "client" ? "index.client.tsx" : "index.server.ts";
    const code = await readFile(path.join(root, entry), "utf8");
    if (code.trim() !== `export { default } from "./${runtime}/bundle.js";`) throw new Error("Native entry must only re-export its runtime bundle: " + entry);
    const result = await build({
      absWorkingDir: root, entryPoints: [entry], bundle: true, platform: runtime === "server" ? "node" : "neutral",
      external: hostModules, format: "cjs", jsx: "automatic", write: false, metafile: true, logLevel: "silent",
    });
    const expected = [entry, runtime + "/bundle.js"].sort();
    if (JSON.stringify(Object.keys(result.metafile.inputs).sort()) !== JSON.stringify(expected)) throw new Error("Native bundle reaches unexpected files: " + Object.keys(result.metafile.inputs).join(", "));
    for (const [file, info] of Object.entries(result.metafile.inputs)) {
      for (const imported of info.imports) {
        if (!imported.external) continue;
        checkSpecifier(imported.path, runtime, file);
        if (!hostModules.includes(imported.path) && !(runtime === "server" && isBuiltin(imported.path))) throw new Error("Unbundled dependency in runtime output: " + imported.path);
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await checkBundles(); console.log("Native entry graphs and bundle externals passed."); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
