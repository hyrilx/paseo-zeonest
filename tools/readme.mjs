import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadFeatures, projectRoot } from "./features.mjs";

const startMarker = "<!-- zeonest:features:start -->";
const endMarker = "<!-- zeonest:features:end -->";

// Metadata is plain text, not Markdown or HTML. Keep table cells and links intact.
function escapeCell(value) {
  return value.replace(/[&<>\\`*_[\]|]/g, (character) => `&#${character.charCodeAt(0)};`)
    .replace(/\r\n?|\n/g, "<br>");
}

export function renderFeatureCatalog(features) {
  if (!features.length) return "当前尚未包含子功能。新增子功能默认关闭。";
  const rows = features.map(({ metadata }) => {
    const { id, name, description, version, tags, author } = metadata;
    const title = `[${escapeCell(name)}](features/${id}/README.md)<br><code>${id}</code>`;
    const labels = tags.length ? tags.map((tag) => `<code>${escapeCell(tag)}</code>`).join(" ") : "—";
    return `| ${title} | ${escapeCell(description)} | ${escapeCell(version)} | ${labels} | ${escapeCell(author)} |`;
  });
  return [
    `当前包含 **${features.length}** 个子功能，默认均关闭；点击名称查看使用说明。`,
    "",
    "| 名称 / ID | 描述 | 版本 | 标签 | 作者 |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/** Only replace the generated block; never rewrite the surrounding documentation. */
export function replaceFeatureCatalog(current, features) {
  const start = current.indexOf(startMarker);
  const end = current.indexOf(endMarker);
  if (start < 0 || end < start
    || current.indexOf(startMarker, start + startMarker.length) !== -1
    || current.indexOf(endMarker, end + endMarker.length) !== -1) {
    throw new Error("README.md must contain exactly one ordered pair of " + startMarker + " and " + endMarker);
  }
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const block = [startMarker, "", renderFeatureCatalog(features), "", endMarker].join("\n").replace(/\n/g, eol);
  return current.slice(0, start) + block + current.slice(end + endMarker.length);
}

export async function updateReadme(root = projectRoot, { check = false } = {}) {
  const file = path.join(root, "README.md");
  const current = await readFile(file, "utf8");
  const updated = replaceFeatureCatalog(current, await loadFeatures(root));
  if (updated === current) return false;
  if (check) throw new Error("README feature catalog is out of date; run npm run docs:features.");
  await writeFile(file, updated);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
      throw new Error("Usage: npm run docs:features -- [--check]");
    }
    const changed = await updateReadme(projectRoot, { check: args.includes("--check") });
    console.log(changed ? "Updated README feature catalog." : "README feature catalog is up to date.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
