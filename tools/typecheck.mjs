import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { loadFeatures, projectRoot, renderEntry } from "./features.mjs";

/** Include the ephemeral composition in tsc so native entry contracts cannot silently drift. */
export async function typecheck(root = projectRoot, tests = true) {
  root = realpathSync(root);
  const features = await loadFeatures(root);
  const virtual = new Map();
  for (const runtime of ["client", "server"]) {
    virtual.set(path.join(root, `.zeonest-entry.${runtime}.ts`), renderEntry(features, runtime));
    virtual.set(path.join(root, runtime, "bundle.d.ts"), `import type { Plugin${runtime === "client" ? "Client" : "Server"}Contribution } from "@getpaseo/plugin/${runtime}"; declare const contribute: Plugin${runtime === "client" ? "Client" : "Server"}Contribution; export default contribute;`);
  }
  for (const config of tests ? ["tsconfig.json", "tsconfig.tests.json"] : ["tsconfig.json"]) {
    const read = ts.readConfigFile(path.join(root, config), ts.sys.readFile);
    if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
    const host = ts.createCompilerHost(parsed.options);
    const getSourceFile = host.getSourceFile.bind(host);
    const directoryExists = host.directoryExists.bind(host);
    host.directoryExists = (directory) => [...virtual.keys()].some((file) => path.dirname(file) === directory) || directoryExists(directory);
    const fileExists = host.fileExists.bind(host);
    const readFile = host.readFile.bind(host);
    host.fileExists = (file) => virtual.has(file) || fileExists(file);
    host.readFile = (file) => virtual.get(file) ?? readFile(file);
    host.getSourceFile = (file, version, onError, shouldCreate) => virtual.has(file)
      ? ts.createSourceFile(file, virtual.get(file), version, true)
      : getSourceFile(file, version, onError, shouldCreate);
    const program = ts.createProgram([...parsed.fileNames, ...virtual.keys()], parsed.options, host);
    const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
    if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => file, getCurrentDirectory: () => root, getNewLine: () => "\n",
    }));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const tests = !process.argv.includes("--runtime");
    await typecheck(projectRoot, tests);
    console.log(tests ? "Runtime, ephemeral native composition and test types passed." : "Runtime and ephemeral native composition types passed.");
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
