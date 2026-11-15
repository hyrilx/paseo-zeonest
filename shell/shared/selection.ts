import type { FeatureMetadata } from "./catalog";

export function enabledFeatureIds(
  catalog: readonly FeatureMetadata[],
  enabled: Readonly<Record<string, boolean>>,
): string[] {
  return catalog.filter(({ id }) => enabled[id] === true).map(({ id }) => id);
}

export function pendingFeatureIds(
  catalog: readonly FeatureMetadata[],
  enabled: Readonly<Record<string, boolean>>,
  applied: readonly string[],
): string[] {
  const running = new Set(applied);
  return catalog
    .filter(({ id }) => (enabled[id] === true) !== running.has(id))
    .map(({ id }) => id);
}
