// Terminal styling is presentation, not status content. Keep newlines for the full-text view.
export function plainStatus(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}
export function pillLabel(key: string, text: string): string {
  // Native Paseo layout handles visual overflow; never impose an artificial text limit.
  return text.replace(/\s+/g, " ").trim() || key;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
