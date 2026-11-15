import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import ts from "typescript";

// Paseo v0.15.4 plugin-sdk-specifiers.ts / compiler-esbuild.ts, not the latest docs.
const clientSdk = ["@getpaseo/plugin/client", "@getpaseo/plugin/client/ui", "@getpaseo/plugin/client/react-native"];
const serverSdk = ["@getpaseo/plugin/server", "@getpaseo/plugin/server/provider", "@getpaseo/plugin/server/usage", "@getpaseo/plugin/server/acp"];
export const sdkModules = ["@getpaseo/plugin", ...clientSdk, ...serverSdk];
export const hostModules = [...sdkModules, "react", "react/jsx-runtime", "react-native", "@tanstack/react-query", "zod"];
const clientOnly = /^(?:(?:@types\/)?react(?:-dom|-native)?|use-sync-external-store|@tanstack\/react-query)(\/|$)/;
const codeFile = /\.[cm]?[jt]sx?$/;

export function checkSpecifier(specifier, runtime, importer) {
  const fail = (reason) => { throw new Error(`${reason}: ${importer} -> ${specifier} (${runtime})`); };
  if (/^@(?:getpaseo|paseo)\/plugin(?:\/|$)/.test(specifier) && !sdkModules.includes(specifier)) fail("Unknown or private SDK module");
  if (/^(?:react|react-native|zod|@tanstack\/react-query)(\/|$)/.test(specifier) && !hostModules.includes(specifier)) fail("Unsupported host dependency subpath");
  if (/^(?:@types\/)?react-dom(\/|$)/.test(specifier)) fail("DOM dependency is not allowed");
  if (runtime !== "server" && (isBuiltin(specifier) || specifier === "@types/node")) fail("Node dependency is not allowed");
  if (runtime !== "server" && serverSdk.includes(specifier)) fail("Server SDK is not allowed");
  if (runtime !== "client" && (clientSdk.includes(specifier) || clientOnly.test(specifier))) fail("Client dependency is not allowed");
}

export function sourceLocation(root, file) {
  const relative = path.relative(root, file).split(path.sep);
  if (relative.includes("node_modules")) return null;
  if (relative[0] === "shell" && ["client", "server", "shared"].includes(relative[1])) {
    return { scope: "shell", runtime: relative[1] };
  }
  if (relative[0] === "features" && relative[1] && ["client", "server", "shared"].includes(relative[2])) {
    return { scope: "features/" + relative[1], runtime: relative[2] };
  }
  throw new Error("Invalid runtime source (tests/tools/root/output cannot be imported): " + file);
}

function checkLocation(root, file, importer, runtime) {
  const target = sourceLocation(root, file);
  if (!target) return;
  if (target.runtime !== "shared" && target.runtime !== runtime) throw new Error("Cross-runtime source dependency: " + importer + " -> " + file);
  const owner = sourceLocation(root, importer);
  if (!owner || target.scope !== owner.scope) throw new Error("Cross-feature/shell implementation dependency: " + importer + " -> " + file);
}

/** All hand-written runtime files, including currently unreferenced helpers. No symlink escapes. */
export async function runtimeSources(root, features) {
  const files = [];
  async function walk(directory) {
    let entries;
    try {
      if ((await lstat(directory)).isSymbolicLink()) throw new Error("Runtime source symlinks are not allowed: " + directory);
      entries = await readdir(directory, { withFileTypes: true });
    }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Runtime source symlinks are not allowed: " + file);
      if (entry.isDirectory()) {
        if (["tests", "fixtures", "node_modules"].includes(entry.name)) throw new Error("Non-runtime directory in runtime source: " + file);
        await walk(file);
      } else if (codeFile.test(file)) files.push(file);
    }
  }
  for (const base of ["shell", ...features.map(({ metadata }) => "features/" + metadata.id)]) {
    if ((await lstat(path.join(root, base))).isSymbolicLink()) throw new Error("Runtime source symlinks are not allowed: " + base);
    for (const runtime of ["client", "server", "shared"]) await walk(path.join(root, base, runtime));
  }
  return files;
}

/** Inspect erased imports as well as value imports; recursively inspect package declarations. */
export function createSourceChecker(root) {
  root = realpathSync(root);
  const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, allowJs: true, jsx: ts.JsxEmit.ReactJSX };
  const cache = new Set();
  const trusted = (name) => hostModules.includes(name) || isBuiltin(name) || name === "@types/node" || name.startsWith("@getpaseo/protocol/");
  function check(file, inheritedRuntime) {
    file = realpathSync(file);
    const location = sourceLocation(root, file);
    const runtime = location?.runtime ?? inheritedRuntime;
    const key = runtime + ":" + file;
    if (cache.has(key) || !codeFile.test(file)) return;
    cache.add(key);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function dependency(specifier, reference = false) {
      checkSpecifier(specifier, runtime, file);
      if (trusted(specifier)) return;
      const local = specifier.startsWith(".") || path.isAbsolute(specifier) ? path.resolve(path.dirname(file), specifier) : undefined;
      if (local) checkLocation(root, local, file, runtime);
      // esbuild embeds local SVG as text; tsc checks its declaration. No general unresolved-import bypass.
      const resolved = !reference && local?.endsWith(".svg")
        ? (existsSync(local) && statSync(local).isFile() ? local : undefined)
        : reference
          ? ts.resolveTypeReferenceDirective(specifier, file, options, ts.sys).resolvedTypeReferenceDirective?.resolvedFileName
          : ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule?.resolvedFileName;
      if (!resolved) throw new Error("Unresolved source dependency: " + file + " -> " + specifier);
      checkLocation(root, resolved, file, runtime);
      const canonical = realpathSync(resolved);
      checkLocation(root, canonical, file, runtime);
      check(canonical, runtime);
    }
    for (const ref of source.typeReferenceDirectives) {
      checkSpecifier(ref.fileName === "node" ? "@types/node" : ref.fileName, runtime, file);
      if (ref.fileName !== "node") dependency(ref.fileName, true);
    }
    for (const ref of source.referencedFiles) dependency(ref.fileName.startsWith(".") ? ref.fileName : "./" + ref.fileName);
    for (const ref of source.libReferenceDirectives) {
      if (/^(dom|webworker)/i.test(ref.fileName)) throw new Error("DOM globals are not allowed: " + file);
    }
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) dependency(node.moduleSpecifier.text);
      else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) dependency(node.moduleReference.expression.text);
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) dependency(node.argument.literal.text);
      else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        const arg = node.arguments[0];
        if (!arg || !ts.isStringLiteralLike(arg)) throw new Error("Non-static module loading is not allowed: " + file);
        dependency(arg.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return check;
}

/** esbuild sees the real runtime dependency graph, including third-party implementation files. */
export function boundaryPlugin(root, runtime, check) {
  return {
    name: "zeonest-source-boundaries",
    setup(builder) {
      builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, ({ path: file }) => {
        check(file, runtime);
        return null;
      });
      builder.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === "entry-point" || args.pluginData?.boundaryResolved) return null;
        const importer = args.importer;
        // The in-memory composition is the only place allowed to connect shell and features.
        const composition = args.namespace === "file" && /\.zeonest-entry\.(client|server)\.ts$/.test(importer);
        let owner = runtime;
        if (importer && !composition) owner = sourceLocation(root, importer)?.runtime ?? runtime;
        checkSpecifier(args.path, owner, importer);
        if (hostModules.includes(args.path)) return { path: args.path, external: true };
        if (isBuiltin(args.path)) return { path: args.path, external: true };
        const resolved = await builder.resolve(args.path, {
          resolveDir: args.resolveDir, kind: args.kind, importer, pluginData: { boundaryResolved: true },
        });
        if (resolved.errors.length) return resolved;
        if (!resolved.external && resolved.path && existsSync(resolved.path) && !composition) {
          checkLocation(root, resolved.path, importer, owner);
          checkLocation(root, realpathSync(resolved.path), importer, owner);
        }
        return resolved;
      });
    },
  };
}
