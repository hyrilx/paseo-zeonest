import { readdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const slug = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

export function validateMetadata(value, directory) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Feature metadata must be an object");
  const expected = ["id", "name", "description", "version", "tags", "author"];
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) throw new Error("Unknown metadata field: " + key);
  }
  for (const key of ["id", "name", "description", "version", "author"]) {
    if (typeof value[key] !== "string" || !value[key].trim()) throw new Error("Missing feature " + key);
  }
  if (!slug.test(value.id) || value.id === "zeonest" || value.id !== directory) {
    throw new Error("Feature ID must match its kebab-case directory and cannot be zeonest");
  }
  if (!semver.test(value.version)) throw new Error("Feature version must be valid SemVer");
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || !tag.trim())) {
    throw new Error("Feature tags must be non-empty strings");
  }
  if (new Set(value.tags).size !== value.tags.length) throw new Error("Feature tags must be unique");
  return Object.fromEntries(expected.map((key) => [key, value[key]]));
}

async function exists(file) {
  try {
    if (!(await lstat(file)).isFile()) throw new Error("Expected a regular file: " + file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function entry(root, id, runtime, name) {
  const base = "features/" + id + "/" + runtime + "/" + name;
  const candidates = [];
  for (const extension of [".ts", ".tsx"]) {
    if (await exists(path.join(root, base + extension))) candidates.push(base + extension);
  }
  if (candidates.length > 1) throw new Error("Ambiguous feature entry: " + base);
  return candidates[0];
}

export async function loadFeatures(root = projectRoot) {
  let directories;
  try { directories = await readdir(path.join(root, "features"), { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const features = [];
  for (const directory of directories.filter((item) => !item.name.startsWith(".")).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (!directory.isDirectory()) throw new Error("Expected a feature directory: " + directory.name);
    const id = directory.name;
    const metadataFile = path.join(root, "features", id, "feature.json");
    if (!await exists(metadataFile)) throw new Error("Missing features/" + id + "/feature.json");
    let metadata;
    try { metadata = validateMetadata(JSON.parse(await readFile(metadataFile, "utf8")), id); }
    catch (error) { throw new Error(metadataFile + ": " + error.message, { cause: error }); }
    const client = await entry(root, id, "client", "index");
    const server = await entry(root, id, "server", "index");
    const clientSettings = await entry(root, id, "client", "settings");
    const serverSettings = await entry(root, id, "server", "settings");
    if (!client && !server) throw new Error("Feature needs a client or server entry: " + id);
    features.push({ metadata, client, server, clientSettings, serverSettings });
  }
  return features;
}

/** Ephemeral, statically typed composition. Never written to the source tree. */
export function renderEntry(features, runtime) {
  if (!["client", "server"].includes(runtime)) throw new Error("Invalid runtime: " + runtime);
  const type = runtime === "client" ? "PluginClient" : "PluginServer";
  const imports = [
    `import type { ${type}Context, ${type}Contribution${runtime === "client" ? ", PluginSettingsScreenContribution" : ""} } from "@getpaseo/plugin/${runtime}";`,
    'import type { FeatureMetadata } from "./shell/shared/catalog";',
    `import { contributeShell } from "./shell/${runtime}/shell";`,
  ];
  const contributions = [];
  const settings = [];
  features.forEach((feature, index) => {
    const id = JSON.stringify(feature.metadata.id);
    if (feature[runtime]) {
      imports.push(`import feature${index} from ${JSON.stringify("./" + feature[runtime])};`);
      contributions.push(`${id}: feature${index}`);
    }
    if (feature[runtime + "Settings"]) {
      imports.push(`import settings${index} from ${JSON.stringify("./" + feature[runtime + "Settings"])};`);
      settings.push(runtime === "client" ? `${id}: settings${index}` : `settings${index}`);
    }
  });
  return imports.join("\n") + "\n"
    + `export const featureCatalog: readonly FeatureMetadata[] = ${JSON.stringify(features.map(({ metadata }) => metadata))};\n`
    + `export const featureContributions: Readonly<Record<string, ${type}Contribution>> = {${contributions.join(",")}};\n`
    + (runtime === "client"
      ? `export const featureSettingsScreens: Readonly<Record<string, PluginSettingsScreenContribution>> = {${settings.join(",")}};\n`
      : `export const featureSettingsContributions: readonly PluginServerContribution[] = [${settings.join(",")}];\n`)
    + `export default function contribute(context: ${type}Context) {\n`
    + `  return contributeShell(context, featureCatalog, featureContributions, ${runtime === "client" ? "featureSettingsScreens" : "featureSettingsContributions"});\n}\n`;
}
