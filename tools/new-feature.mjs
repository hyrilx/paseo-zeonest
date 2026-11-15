import { mkdir, writeFile, lstat, rm } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { projectRoot, validateMetadata, syncFeatures } from "./features.mjs";

export function featureFiles(metadata, runtime = "both", settings = false) {
  validateMetadata(metadata, metadata.id);
  if (!["client", "server", "both"].includes(runtime)) throw new Error("Runtime must be client, server, or both");
  const { id, name } = metadata;
  const title = JSON.stringify(name);
  const files = {
    ["features/" + id + "/feature.json"]: JSON.stringify(metadata, null, 2) + "\n",
    ["features/" + id + "/README.md"]: "# " + name + "\n\n" + metadata.description
      + "\n\n## 实现\n\n使用 Paseo 原生 SDK 实现本功能；配置、数据、权限和资源清理由本功能自行管理。\n\n"
      + "## 验收\n\n记录实际行为、数据访问、失败处理和验证命令后再集成使用。新增功能默认关闭。\n",
  };
  for (const side of ["client", "server"]) {
    if (runtime !== "both" && runtime !== side) continue;
    const type = side === "client" ? "PluginClientContext" : "PluginServerContext";
    files[side + "/features/" + id + "/index.ts"] = 'import type { ' + type
      + ' } from "@getpaseo/plugin/' + side + '";\n\n'
      + "export default function contribute(_" + side + ": " + type + ") {\n"
      + "  return () => {};\n}\n";
  }
  if (settings) {
    files["shared/features/" + id + "/settings.ts"] = 'import { defineSettings } from "@getpaseo/plugin";\nimport { z } from "zod";\n\n'
      + "export const preferences = defineSettings({\n  id: " + JSON.stringify(id + "-preferences")
      + ',\n  scope: "host",\n  version: 1,\n  schema: z.object({}),\n});\n';
    files["server/features/" + id + "/settings.ts"] = 'import type { PluginServerContext } from "@getpaseo/plugin/server";\n'
      + 'import { preferences } from "../../../shared/features/' + id + '/settings";\n\n'
      + "export default function contributeSettings(server: PluginServerContext) {\n"
      + "  server.registerSettings(preferences);\n  return () => {};\n}\n";
    files["client/features/" + id + "/settings.tsx"] = 'import type { PluginSettingsScreenContribution, PluginSurfaceProps } from "@getpaseo/plugin/client";\n'
      + 'import { useSettings } from "@getpaseo/plugin/client";\n'
      + 'import { SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";\n'
      + 'import { preferences } from "../../../shared/features/' + id + '/settings";\n\n'
      + "function Settings(_props: PluginSurfaceProps) {\n"
      + "  const settings = useSettings(preferences);\n"
      + "  return (\n    <SettingsSection title={" + title + "}>\n      <SettingsCard>\n"
      + '        {settings.status === "ready" ? <SettingsRow label="暂无配置项" />\n'
      + '          : settings.status === "loading" ? <SettingsRow label="正在读取配置…" />\n'
      + '          : <SettingsAction label={settings.error} actionLabel="重新读取" onPress={() => { void settings.reload(); }} />}\n'
      + "      </SettingsCard>\n    </SettingsSection>\n  );\n}\n\n"
      + "export default {\n  id: " + JSON.stringify(id + "-settings") + ",\n  title: " + title
      + ',\n  icon: "Settings",\n  Component: Settings,\n} satisfies PluginSettingsScreenContribution;\n';
  }
  return files;
}

export async function createFeature(root, metadata, runtime, settings) {
  const files = featureFiles(metadata, runtime, settings);
  // Reject any pre-existing subtree rather than merging or overwriting user code.
  const directories = ["features", "client/features", "server/features", "shared/features"]
    .map((base) => path.join(root, base, metadata.id));
  for (const directory of directories) {
    try { await lstat(directory); throw new Error("Feature path already exists: " + directory); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  try {
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, { flag: "wx" });
    }
    await syncFeatures(root);
  } catch (error) {
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
    await syncFeatures(root).catch(() => {});
    throw error;
  }
  return Object.keys(files);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        name: { type: "string" }, description: { type: "string" }, author: { type: "string" },
        version: { type: "string", default: "0.1.0" }, tag: { type: "string", multiple: true, default: [] },
        runtime: { type: "string", default: "both" }, settings: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    if (values.help) {
      console.log('npm run feature:new -- <id> --name "名称" --description "说明" --author "作者" [--runtime client|server|both] [--settings] [--tag ui]');
    } else {
      if (positionals.length !== 1) throw new Error("Provide exactly one feature ID; use --help for usage");
      const metadata = { id: positionals[0], name: values.name, description: values.description,
        version: values.version, tags: values.tag, author: values.author };
      const files = await createFeature(projectRoot, metadata, values.runtime, values.settings);
      console.log("Created " + files.length + " files. Implement the feature, then run npm run check.");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
