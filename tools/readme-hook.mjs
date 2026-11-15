import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadFeatures, projectRoot } from "./features.mjs";
import { replaceFeatureCatalog } from "./readme.mjs";

function git(root, args, options = {}) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", ...options });
}

/** Generate from the index, not unstaged files, and stage only the generated block. */
export async function stageReadme(root = projectRoot) {
  const changed = git(root, ["diff", "--cached", "--name-only", "-z"]).split("\0");
  if (!changed.some((file) => file === "README.md" || /^features\/[^/]+\/feature\.json$/.test(file))) return false;
  const mode = git(root, ["ls-files", "--stage", "--", "README.md"]).split(" ")[0];
  if (!["100644", "100755"].includes(mode)) throw new Error("README.md must be a regular staged file");

  const snapshot = await mkdtemp(path.join(tmpdir(), "zeonest-readme-"));
  try {
    // A temporary checkout reuses the normal scanner, including entry/metadata validation.
    git(root, ["checkout-index", "--all", "--ignore-skip-worktree-bits", "--prefix=" + snapshot + path.sep]);
    // Read the actual blob: checkout-index may apply core.autocrlf or checkout filters.
    const staged = git(root, ["show", ":README.md"]);
    const features = await loadFeatures(snapshot);
    const generated = replaceFeatureCatalog(staged, features);
    if (generated === staged) return false;

    const workingFile = path.join(root, "README.md");
    const working = await readFile(workingFile, "utf8");
    const updated = replaceFeatureCatalog(working, features);
    const hash = git(root, ["hash-object", "-w", "--stdin"], { input: generated }).trim();
    if (updated !== working) await writeFile(workingFile, updated);
    // Preserve the index's handwritten text; git add README.md would include unstaged edits.
    git(root, ["update-index", "--cacheinfo", mode, hash, "README.md"]);
    return true;
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (await stageReadme()) console.log("Updated and staged README feature catalog.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
