/** Allocate a display name from the latest cloud library; identity always uses a new project ID. */
export function availableCloudProjectName(requested: string, names: readonly string[]): string {
  const base = requested.trim().slice(0, 120);
  const used = new Set(names.map((name) => name.trim()));
  if (!used.has(base)) return base;
  for (let number = 2; ; number += 1) {
    const suffix = ` (${number})`;
    const candidate = base.slice(0, 120 - suffix.length).trimEnd() + suffix;
    if (!used.has(candidate)) return candidate;
  }
}
