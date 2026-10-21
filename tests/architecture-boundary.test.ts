import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(projectRoot, 'src');
const pluginRoot = join(sourceRoot, 'plugins');

test('feature plugins do not import another feature implementation', () => {
  const violations: string[] = [];
  for (const file of sourceFiles(pluginRoot)) {
    const relativeFile = relative(pluginRoot, file);
    const segments = relativeFile.split(sep);
    const sourceFeature = segments.length > 1 ? segments[0] : undefined;
    if (!sourceFeature || ['index.ts', 'manifest.ts', 'stubs.ts'].includes(relativeFile)) continue;

    const source = readFileSync(file, 'utf8');
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue;
      const target = normalize(resolve(dirname(file), specifier));
      if (!target.startsWith(pluginRoot + sep)) continue;
      const targetRelative = relative(pluginRoot, target);
      if (targetRelative === 'manifest.ts' || targetRelative === 'manifest') continue;
      const targetFeature = targetRelative.split(sep)[0];
      if (targetFeature !== sourceFeature) {
        violations.push(`${relativeFile} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('headless core has no dependency on shell or feature plugins', () => {
  const violations: string[] = [];
  for (const file of sourceFiles(join(sourceRoot, 'core'))) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of importSpecifiers(source)) {
      if (specifier.includes('/plugins/') || specifier.includes('/shell/')) {
        violations.push(`${relative(sourceRoot, file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('headless plugin models do not load React views', () => {
  const violations: string[] = [];
  for (const file of sourceFiles(pluginRoot).filter((path) => path.endsWith(`${sep}model.ts`))) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of importSpecifiers(source)) {
      if (specifier.endsWith('.tsx')) violations.push(`${relative(pluginRoot, file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('source avoids unmanaged persistence and executable content escape hatches', () => {
  const forbidden = [
    ['localStorage', /\blocalStorage\b/],
    ['sessionStorage', /\bsessionStorage\b/],
    ['eval', /\beval\s*\(/],
    ['dangerouslySetInnerHTML', /\bdangerouslySetInnerHTML\b/],
  ] as const;
  const violations: string[] = [];
  for (const file of sourceFiles(sourceRoot)) {
    const source = readFileSync(file, 'utf8');
    for (const [label, pattern] of forbidden) {
      if (pattern.test(source)) violations.push(`${relative(sourceRoot, file)} uses ${label}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('feature plugins use governed network and worker services', () => {
  const violations: string[] = [];
  for (const file of sourceFiles(pluginRoot)) {
    const source = readFileSync(file, 'utf8');
    if (/(?<![.\w])fetch\s*\(/u.test(source)) {
      violations.push(`${relative(pluginRoot, file)} calls global fetch`);
    }
    if (/\bnew\s+(?:globalThis\.)?Worker\s*\(/u.test(source)) {
      violations.push(`${relative(pluginRoot, file)} constructs an unmanaged Worker`);
    }
  }
  assert.deepEqual(violations, []);
});

test('every registered public action has at least one centrally managed shortcut', () => {
  const missing: string[] = [];
  for (const file of sourceFiles(pluginRoot)) {
    const source = readFileSync(file, 'utf8');
    const actionCommands = contributionCommands(source, 'action');
    if (actionCommands.length === 0) continue;
    const shortcutCommands = new Set(contributionCommands(source, 'shortcut'));
    for (const command of actionCommands) {
      if (!shortcutCommands.has(command)) {
        missing.push(`${relative(pluginRoot, file)} -> ${command}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('shipped application starts from a fresh persistence session', () => {
  const composition = readFileSync(join(sourceRoot, 'app', 'create-application.ts'), 'utf8');
  const persistence = readFileSync(join(sourceRoot, 'core', 'persistence.ts'), 'utf8');
  assert.match(composition, /persistenceLaunchPolicy:\s*'fresh-session'/u);
  assert.match(persistence, /policy === 'fresh-session'/u);
  for (const store of ['snapshots', 'journal', 'recovery', 'contentChunks']) {
    assert.match(persistence, new RegExp(`objectStore\\('${store}'\\)\\.clear\\(\\)`, 'u'));
  }
  assert.doesNotMatch(persistence, /objectStore\('meta'\)\.clear\(\)/u);
  assert.match(persistence, /PERSONAL_PREFERENCE_PREFIX/u);
});

test('portable composition keeps the library and cloud UI without file-origin network access', () => {
  const composition = readFileSync(join(sourceRoot, 'plugins', 'index.ts'), 'utf8');
  const cloud = readFileSync(join(sourceRoot, 'plugins', 'cloud-sync', 'model.ts'), 'utf8');
  assert.match(composition, /import \{ cloudSyncPlugin \} from '\.\/cloud-sync\/plugin\.ts'/u);
  assert.match(composition, /import \{ bookLibraryPlugin \} from '\.\/book-library\/plugin\.ts'/u);
  assert.ok(composition.lastIndexOf('cloudSyncPlugin,') < composition.lastIndexOf('bookLibraryPlugin,'));
  assert.match(cloud, /url\.protocol === 'http:' \|\| url\.protocol === 'https:'/u);
  assert.match(cloud, /if \(controlOrigin\) \{[\s\S]*?refreshControlStatus/u);
  assert.match(cloud, /else \{\s*update\(\{ phase: 'disabled', configured: false/u);
});

test('hosted server rendering never constructs the browser kernel', () => {
  const runtime = readFileSync(join(sourceRoot, 'app', 'InfiniteCanvasRuntime.tsx'), 'utf8');
  const hosted = readFileSync(
    join(sourceRoot, 'app', 'HostedInfiniteCanvasApplication.tsx'),
    'utf8',
  );
  assert.match(runtime, /useState<ApplicationKernel \| null>\(null\)/u);
  assert.match(
    runtime,
    /useEffect\(\(\) => \{[\s\S]*?Promise\.resolve\(\)\.then\(createKernel\)[\s\S]*?setKernel\(nextKernel\)[\s\S]*?\}, \[createKernel\]\);/u,
  );
  assert.doesNotMatch(runtime, /useState<ApplicationKernel \| null>\(\(\) =>[\s\S]*?createKernel\(\)/u);
  assert.doesNotMatch(hosted, /import \{ createHostedApplication \} from/u);
  assert.match(hosted, /await import\('\.\/create-hosted-application\.ts'\)/u);
});

test('application chrome does not ship unreadably small fixed pixel text', () => {
  const css = readFileSync(join(projectRoot, 'app', 'globals.css'), 'utf8');
  const sizes = [
    ...[...css.matchAll(/font-size:\s*([0-9.]+)px/gu)].map((match) => Number(match[1])),
    ...[...css.matchAll(/font:\s*([0-9.]+)px\//gu)].map((match) => Number(match[1])),
  ];
  assert.deepEqual(sizes.filter((size) => size < 11), []);
});

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (['.ts', '.tsx'].includes(extname(path))) files.push(path);
  }
  return files;
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g)].map(
    (match) => match[1],
  );
}

function contributionCommands(source: string, kind: 'action' | 'shortcut'): string[] {
  const pattern = new RegExp(
    String.raw`context\.ui\.${kind}\(\{[\s\S]*?\bcommand:\s*'([^']+)'[\s\S]*?\}\);`,
    'gu',
  );
  return [...source.matchAll(pattern)].map((match) => match[1]);
}
