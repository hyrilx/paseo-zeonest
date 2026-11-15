import { build } from "esbuild";
import path from "node:path";
import { projectRoot } from "./features.mjs";
import { fileURLToPath } from "node:url";

/** Build both static graphs and enforce Paseo's runtime directory boundaries. */
export async function checkBundles(root = projectRoot) {
  for (const runtime of ["client", "server"]) {
    const result = await build({
      absWorkingDir: root, entryPoints: [runtime === "client" ? "index.client.tsx" : "index.server.ts"],
      bundle: true, packages: "external", platform: runtime === "server" ? "node" : "neutral",
      format: "esm", jsx: "automatic", write: false, metafile: true, logLevel: "silent",
    });
    for (const [file, info] of Object.entries(result.metafile.inputs)) {
      const normalized = file.replaceAll("\\", "/");
      const owner = normalized.split("/")[0];
      if (![runtime, "shared"].includes(owner) && !/^index\.(client|server)\.tsx?$/.test(normalized)) {
        throw new Error(runtime + " bundle reaches an invalid runtime module: " + file);
      }
      for (const imported of info.imports) {
        if (!imported.external) continue;
        const module = imported.path;
        if (module.startsWith(".")) throw new Error("Unbundled local module: " + module);
        if (owner === "shared" && (
          module !== "@getpaseo/plugin" && module !== "zod"
        )) throw new Error("Shared module imports a runtime dependency: " + file + " -> " + module);
        if (runtime === "client") {
          const allowed = ["@getpaseo/plugin", "@getpaseo/plugin/client", "@getpaseo/plugin/client/ui",
            "react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-native", "@tanstack/react-query", "zod"];
          if (!allowed.includes(module)) throw new Error("Client module is not host-provided: " + file + " -> " + module);
        } else if (module === "react" || module.startsWith("react/") || module === "react-native"
          || module.startsWith("@getpaseo/plugin/client")) {
          throw new Error("Server module imports client runtime: " + file + " -> " + module);
        }
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await checkBundles(); console.log("Client and server bundle graphs passed."); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
