import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stageRoot = resolve(projectRoot, '.portable-stage');
const outputRoot = resolve(projectRoot, 'artifacts');
const outputFile = resolve(outputRoot, 'Echo-8.html');
const rulesOutputFile = resolve(outputRoot, 'Echo-8-text-assist-rules.txt');

assertInsideProject(stageRoot);
assertInsideProject(outputRoot);

await build({ configFile: resolve(projectRoot, 'vite.portable.config.ts') });
let html = await readFile(resolve(stageRoot, 'portable.html'), 'utf8');
const rulesText = await readFile(resolve(projectRoot, 'public/Echo-8-text-assist-rules.txt'), 'utf8');
const faviconSvg = await readFile(resolve(projectRoot, 'public/favicon.svg'), 'utf8');
const faviconDataUrl = `data:image/svg+xml,${encodeURIComponent(faviconSvg)}`;
html = html
  .replaceAll('./favicon.svg', faviconDataUrl)
  .replaceAll('/favicon.svg', faviconDataUrl);

const stylesheet = html.match(/<link[^>]+href="([^"]+\.css)"[^>]*>/u);
if (stylesheet) {
  const css = await readFile(resolveAsset(stylesheet[1]), 'utf8');
  html = html.replace(stylesheet[0], () => `<style>${css}</style>`);
}

const moduleScript = html.match(/<script[^>]+type="module"[^>]+src="([^"]+\.js)"[^>]*><\/script>/u);
if (!moduleScript) throw new Error('Portable build did not emit one module script');
const javascript = (await readFile(resolveAsset(moduleScript[1]), 'utf8'))
  .replaceAll('/favicon.svg', faviconDataUrl)
  .replace(/<\/script/giu, '<\\/script');
html = html.replace(moduleScript[0], () => `<script type="module">${javascript}</script>`);

const remainingAsset = html.match(/<(?:script|link)[^>]+(?:src|href)="\.\/assets\//u);
if (remainingAsset) throw new Error(`Portable HTML still references an external build asset: ${remainingAsset[0]}`);

await mkdir(outputRoot, { recursive: true });
await writeFile(outputFile, html, 'utf8');
await writeFile(rulesOutputFile, rulesText, 'utf8');
await rm(stageRoot, { recursive: true, force: true });

const bytes = Buffer.byteLength(html);
process.stdout.write(`Portable HTML: ${relative(projectRoot, outputFile)} (${bytes.toLocaleString()} bytes)\n`);

function resolveAsset(reference) {
  const clean = reference.replace(/^\.\//u, '');
  const path = resolve(stageRoot, clean);
  if (!path.startsWith(`${stageRoot}\\`) && path !== stageRoot) throw new Error('Portable asset escaped stage directory');
  return path;
}

function assertInsideProject(path) {
  if (!path.startsWith(`${projectRoot}\\`) || path === projectRoot) {
    throw new Error(`Unsafe portable build path: ${path}`);
  }
}
