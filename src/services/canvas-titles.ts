export function normalizeCanvasTitle(text: string): string {
  return text.normalize('NFKC').trim().toLocaleLowerCase();
}

export function canvasTitleAliases(title: string): string[] {
  const key = normalizeCanvasTitle(title);
  const base = key.replace(/\s+\d+$/u, '');
  const parts = base.split('|').map(part => part.trim()).filter(Boolean);
  const numbered = [key, ...key.split('|').map(part => part.trim())].flatMap(part => {
    const match = /^(.+?\p{Script=Han})\s*(\d+)$/u.exec(part);
    return match ? [match[1] + match[2], match[1] + ' ' + match[2]] : [];
  });
  return [...new Set([key, base, ...parts, ...numbered])].filter(Boolean);
}
