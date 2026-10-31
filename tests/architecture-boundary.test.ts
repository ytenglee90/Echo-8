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

test('feature implementations depend on the public plugin SDK, protocols, UI, and services only', () => {
  const violations: string[] = [];
  for (const file of sourceFiles(pluginRoot)) {
    const relativeFile = relative(pluginRoot, file);
    if (!relativeFile.includes(sep)) continue;
    const source = readFileSync(file, 'utf8');
    for (const specifier of importSpecifiers(source)) {
      const coreIndex = specifier.indexOf('/core/');
      if (coreIndex < 0) continue;
      if (specifier.slice(coreIndex + '/core/'.length) !== 'contracts.ts') {
        violations.push(`${relativeFile} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('cloud wire contracts do not depend on kernel implementations', () => {
  const source = readFileSync(join(sourceRoot, 'cloud', 'contracts.ts'), 'utf8');
  assert.deepEqual(importSpecifiers(source).filter((specifier) => specifier.includes('/core/')), []);
});

test('public protocols do not import kernel implementation modules', () => {
  const violations: string[] = [];
  for (const file of sourceFiles(join(sourceRoot, 'protocols'))) {
    for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
      const coreIndex = specifier.indexOf('/core/');
      if (coreIndex >= 0 && specifier.slice(coreIndex + '/core/'.length) !== 'contracts.ts') {
        violations.push(`${relative(sourceRoot, file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('built-in message names use closed protocol registries and an explicit dynamic command boundary', () => {
  const commands = readFileSync(join(sourceRoot, 'protocols', 'commands.ts'), 'utf8');
  const messages = readFileSync(join(sourceRoot, 'protocols', 'messages.ts'), 'utf8');
  const contracts = readFileSync(join(sourceRoot, 'core', 'contracts.ts'), 'utf8');

  assert.doesNotMatch(commands, /UnregisteredCommand|TType extends string/u);
  assert.match(contracts, /dispatchDynamic\(type: string/u);
  assert.match(contracts, /ask<TResult = unknown>\(type: KnownQueryType/u);
  assert.match(contracts, /capability: KnownCapabilityType/u);
  assert.match(messages, /export interface ApplicationQueryMap/u);
  assert.match(messages, /export interface ApplicationCapabilityMap/u);
});

test('retired plugin data stays plugin-owned and core cleanup stays schema-neutral', () => {
  const registry = readFileSync(join(sourceRoot, 'core', 'retired-data-registry.ts'), 'utf8');
  const forbiddenPluginSchemas = /textNode|aiProposals|recentBuckets|recentWindowMs|clipboard/u;
  assert.doesNotMatch(registry, forbiddenPluginSchemas);

  const owners = [
    join(pluginRoot, 'text-node', 'plugin.ts'),
    join(pluginRoot, 'ai-assistant', 'model.ts'),
    join(pluginRoot, 'editor', 'model.ts'),
    join(pluginRoot, 'clipboard', 'model.ts'),
  ].map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.match(owners, /retiredDataScrubbers/u);
});

test('plugin category is declared rather than inferred from identifiers', () => {
  const contracts = readFileSync(join(sourceRoot, 'core', 'contracts.ts'), 'utf8');
  const manager = readFileSync(join(sourceRoot, 'core', 'plugin-manager.ts'), 'utf8');
  assert.match(contracts, /category: PluginCategory/u);
  assert.match(manager, /const category = manifest\.category/u);
  assert.doesNotMatch(manager, /manifest\.id\.(?:includes|startsWith).*category/u);
});

test('feature code does not construct raw browser file-picker DOM', () => {
  const violations: string[] = [];
  for (const file of sourceFiles(pluginRoot)) {
    const source = readFileSync(file, 'utf8');
    if (/showOpenFilePicker|document\.createElement\(['"]input['"]\)/u.test(source)) {
      violations.push(relative(pluginRoot, file));
    }
  }
  assert.deepEqual(violations, []);
});

test('annotation autosave has one tracked debounce and no detached retry timer', () => {
  const source = readFileSync(
    join(pluginRoot, 'annotations', 'AnnotationPopup.tsx'),
    'utf8',
  );
  assert.equal([...source.matchAll(/\bsetTimeout\(/gu)].length, 1);
  assert.match(source, /clearTimeout\(timer\)/u);
  assert.match(source, /savePromise/u);
  assert.doesNotMatch(source, /finally\([\s\S]{0,200}setTimeout/u);
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
  assert.match(composition, /PersistenceLaunchPolicy\s*=\s*'fresh-session'/u);
  assert.match(persistence, /policy === 'fresh-session'/u);
  for (const store of ['snapshots', 'journal', 'recovery', 'contentChunks']) {
    assert.match(persistence, new RegExp(`objectStore\\('${store}'\\)\\.clear\\(\\)`, 'u'));
  }
  assert.doesNotMatch(persistence, /objectStore\('meta'\)\.clear\(\)/u);
  assert.match(persistence, /PERSONAL_PREFERENCE_PREFIX/u);
});

test('portable composition keeps the library and cloud UI without file-origin network access', () => {
  const composition = readFileSync(join(sourceRoot, 'plugins', 'composition.ts'), 'utf8');
  const portable = readFileSync(join(sourceRoot, 'plugins', 'index.ts'), 'utf8');
  const hosted = readFileSync(join(sourceRoot, 'plugins', 'hosted-lazy.ts'), 'utf8');
  const cloud = readFileSync(join(sourceRoot, 'plugins', 'cloud-sync', 'model.ts'), 'utf8');
  assert.match(composition, /import \{ cloudSyncPlugin \} from '\.\/cloud-sync\/plugin\.ts'/u);
  assert.match(composition, /import \{ bookLibraryPlugin \} from '\.\/book-library\/plugin\.ts'/u);
  assert.ok(composition.lastIndexOf('cloudSyncPlugin,') < composition.lastIndexOf('bookLibraryPlugin,'));
  assert.match(portable, /composeBuiltInPlugins\(semanticProviderPlugin\)/u);
  assert.match(hosted, /composeBuiltInPlugins\(lazySemanticProvider\)/u);
  assert.doesNotMatch(portable, /cloudSyncPlugin|bookLibraryPlugin/u);
  assert.doesNotMatch(hosted, /cloudSyncPlugin|bookLibraryPlugin/u);
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
    /useEffect\(\(\) => \{[\s\S]*?launchSafeMode = isSafeStartRequested\(\)[\s\S]*?Promise\.resolve\(\)\.then\(\(\) =>[\s\S]*?createKernel\([\s\S]*?setKernel\(nextKernel\)[\s\S]*?\}, \[createKernel\]\);/u,
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
  return [
    ...source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/gu),
    ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu),
  ].map((match) => match[1]);
}

function contributionCommands(source: string, kind: 'action' | 'shortcut'): string[] {
  const pattern = new RegExp(
    String.raw`context\.ui\.${kind}\(\{[\s\S]*?\bcommand:\s*'([^']+)'[\s\S]*?\}\);`,
    'gu',
  );
  return [...source.matchAll(pattern)].map((match) => match[1]);
}
