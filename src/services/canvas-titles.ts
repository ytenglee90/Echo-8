export function normalizeCanvasTitle(text: string): string {
  return text.normalize('NFKC').trim().toLocaleLowerCase();
}

export function canvasTitleAliases(title: string): string[] {
  const key = normalizeCanvasTitle(title);
  const base = key.replace(/\s+\d+$/u, '');
  const parts = base.split('|').map(part => part.trim()).filter(Boolean);
  return [...new Set([key, base, ...parts])].filter(Boolean);
}
