import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stylesDirectory = path.join(projectRoot, 'app', 'styles');
const expectedImports = [
  "@import 'tailwindcss';",
  "@import './styles/foundation.css';",
  "@import './styles/shell-base.css';",
  "@import './styles/canvas.css';",
  "@import './styles/feature-controls.css';",
  "@import './styles/editor.css';",
  "@import './styles/feature-panels.css';",
  "@import './styles/book-library.css';",
  "@import './styles/ai-base.css';",
  "@import './styles/shell.css';",
  "@import './styles/editor-layout.css';",
  "@import './styles/feature-layout.css';",
  "@import './styles/ai-toolbar.css';",
  "@import './styles/ai-assistant.css';",
  "@import './styles/ai-settings-base.css';",
  "@import './styles/ai-settings-local.css';",
  "@import './styles/ai-settings-retrieval.css';",
  "@import './styles/ai-settings-model.css';",
  "@import './styles/ai-settings-layout.css';",
  "@import './styles/ai-memory.css';",
  "@import './styles/ai-memory-cards.css';",
  "@import './styles/ai-secondary.css';",
];

test('global styles keep an explicit cascade order', async () => {
  const source = await readFile(path.join(projectRoot, 'app', 'globals.css'), 'utf8');
  assert.deepEqual(source.trim().split(/\r?\n/u), expectedImports);
});

test('each stylesheet owner has no duplicate selector blocks', async () => {
  const files = (await readdir(stylesDirectory)).filter((name) => name.endsWith('.css')).sort();
  const duplicates: string[] = [];
  for (const file of files) {
    const selectors = readSelectorBlocks(await readFile(path.join(stylesDirectory, file), 'utf8'));
    const seen = new Set<string>();
    for (const selector of selectors) {
      if (seen.has(selector)) duplicates.push(`${file}: ${selector}`);
      seen.add(selector);
    }
  }
  assert.deepEqual(duplicates, []);
});

test('shell, editor, feature and AI toolbar selectors stay with their owning stylesheets', async () => {
  const shell = await readFile(path.join(stylesDirectory, 'shell.css'), 'utf8');
  const editor = `${await readFile(path.join(stylesDirectory, 'editor.css'), 'utf8')}\n${
    await readFile(path.join(stylesDirectory, 'editor-layout.css'), 'utf8')}`;
  const features = `${await readFile(path.join(stylesDirectory, 'feature-controls.css'), 'utf8')}\n${
    await readFile(path.join(stylesDirectory, 'feature-layout.css'), 'utf8')}`;
  const aiToolbar = await readFile(path.join(stylesDirectory, 'ai-toolbar.css'), 'utf8');
  assert.doesNotMatch(shell, /\.(?:editor-|immersive-|search-|group-membership|ai-toolbar)/u);
  assert.doesNotMatch(editor, /\.(?:search-|plugin-|group-membership|ai-toolbar)/u);
  assert.doesNotMatch(features, /\.(?:editor-|immersive-|ai-toolbar)/u);
  assert.doesNotMatch(aiToolbar, /\.(?:editor-|immersive-|search-|group-membership|plugin-)/u);
});

function readSelectorBlocks(source: string): string[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//gu, '');
  const stack: Array<{ kind: 'at' | 'rule'; prelude: string }> = [];
  const selectors: string[] = [];
  let tokenStart = 0;
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{') {
      const prelude = text.slice(tokenStart, index).trim();
      const parent = stack.at(-1);
      const isAtRule = prelude.startsWith('@');
      const inKeyframes = stack.some((item) => item.prelude.startsWith('@keyframes'));
      if (!isAtRule && !inKeyframes && (!parent || parent.kind === 'at')) {
        const context = stack
          .filter((item) => item.kind === 'at')
          .map((item) => item.prelude.replace(/\s+/gu, ' '))
          .join(' > ');
        selectors.push(`${context}::${prelude.replace(/\s+/gu, ' ')}`);
      }
      stack.push({ kind: isAtRule ? 'at' : 'rule', prelude });
      tokenStart = index + 1;
    } else if (character === '}') {
      stack.pop();
      tokenStart = index + 1;
    } else if (character === ';' && stack.length === 0) {
      tokenStart = index + 1;
    }
  }
  return selectors;
}
