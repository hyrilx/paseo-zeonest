// Parse argv, not shell syntax: no expansion, substitution, pipes or redirection.
export function parseArguments(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "\\" && quote !== "'") {
      const next = text[++i];
      if (next === undefined) throw new Error("构建选项末尾的反斜杠未转义任何字符");
      current += next;
      started = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === "\"" || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) { args.push(current); current = ""; started = false; }
    } else { current += char; started = true; }
  }
  if (quote) throw new Error("构建选项有未闭合的引号");
  if (started) args.push(current);
  return args;
}

export const formatArguments = (args: readonly string[]) => args.map((arg) => /^[\w@./:=+-]+$/u.test(arg) ? arg : JSON.stringify(arg)).join(" ");
