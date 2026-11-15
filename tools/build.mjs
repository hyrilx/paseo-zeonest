import { build } from "esbuild";
import { realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadFeatures, projectRoot, renderEntry } from "./features.mjs";
import { boundaryPlugin, createSourceChecker, runtimeSources, sourceLocation } from "./boundaries.mjs";

/** Validate both graphs before writing either bundle; output directories are disposable. */
export async function buildPlugin(root = projectRoot) {
  root = realpathSync(root);
  const outputs = ["client", "server"];
  // Output directories are reserved exclusively for this tool.
  for (const side of outputs) await rm(path.join(root, side), { recursive: true, force: true });
  const features = await loadFeatures(root);
  const sources = await runtimeSources(root, features);
  const check = createSourceChecker(root);
  for (const file of sources) check(file, sourceLocation(root, file).runtime);
  const common = {
    absWorkingDir: root, bundle: true, format: "esm", jsx: "automatic", metafile: true,
    write: false, logLevel: "silent", loader: { ".svg": "text" },
    // No source paths or source maps in the distributed code.
    minify: false, minifyWhitespace: true, legalComments: "inline",
  };
  // Shared ownership must propagate through third-party runtime dependencies, not just declarations.
  const shared = sources.filter((file) => sourceLocation(root, file).runtime === "shared" && !/\.d\.[cm]?ts$/.test(file));
  if (shared.length) await build({
    ...common, entryPoints: shared, outdir: path.join(root, ".shared-probe"), platform: "neutral",
    plugins: [boundaryPlugin(root, "shared", check)],
  });
  const results = {};
  for (const runtime of outputs) {
    const result = await build({
      ...common,
      stdin: { contents: renderEntry(features, runtime), resolveDir: root, sourcefile: `.zeonest-entry.${runtime}.ts`, loader: "ts" },
      outfile: path.join(root, runtime, "bundle.js"), platform: runtime === "server" ? "node" : "neutral",
      target: runtime === "server" ? "node20" : "es2020", mainFields: ["module", "main"],
      plugins: [boundaryPlugin(root, runtime, check)],
    });
    results[runtime] = result;
  }
  for (const runtime of outputs) {
    await mkdir(path.join(root, runtime), { recursive: true });
    await writeFile(path.join(root, runtime, "bundle.js"), results[runtime].outputFiles[0].contents);
    await writeFile(path.join(root, runtime, "bundle.d.ts"),
      `import type { Plugin${runtime === "client" ? "Client" : "Server"}Contribution } from "@getpaseo/plugin/${runtime}";\ndeclare const contribute: Plugin${runtime === "client" ? "Client" : "Server"}Contribution;\nexport default contribute;\n`);
  }
  return { features, results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await buildPlugin(); console.log("Built client/bundle.js and server/bundle.js (source boundaries checked)."); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
