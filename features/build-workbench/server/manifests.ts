// Read the literal TOML declarations used for static discovery. Cargo (not this
// reader) is responsible for interpreting the full manifest during a build.
export function section(text: string, name: string) {
  const blocks = text.split(/^\s*\[[^\r\n]+\][ \t]*(?:#[^\r\n]*)?$/mu);
  const headers = [...text.matchAll(/^\s*\[([^\r\n]+)\][ \t]*(?:#[^\r\n]*)?$/gmu)];
  const i = headers.findIndex((m) => m[1] === name);
  return i < 0 ? undefined : blocks[i + 1];
}

export function literal(text: string | undefined, name: string) {
  const line = text?.split(/\r?\n/u).find((l) => l.trimStart().startsWith(name) && l.trimStart().slice(name.length).trimStart().startsWith("="));
  return line?.slice(line.indexOf("=") + 1).match(/^\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/u)?.slice(1).find((s) => s !== undefined);
}

export function array(text: string | undefined, name: string): string[] {
  const start = text?.split(/\r?\n/u).findIndex((line) => line.trimStart().startsWith(name) && line.trimStart().slice(name.length).trimStart().startsWith("=")) ?? -1;
  if (start < 0 || text === undefined) return [];
  const value = text.split(/\r?\n/u).slice(start).join("\n").match(/^[^=]+=\s*\[([\s\S]*?)\]/u)?.[1];
  return [...(value ?? "").matchAll(/#[^\r\n]*|"([^"\\\r\n]+)"|'([^'\r\n]+)'/gu)].flatMap((m) => m[1] ?? m[2] ?? []);
}
