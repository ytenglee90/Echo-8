import { spawn } from 'node:child_process';
const run = args => new Promise(resolve => {
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, ECHO8_OFFLINE_TESTS: '1' } });
  child.on('error', () => resolve(1)); child.on('exit', code => resolve(code ?? 1));
});
const assets = await run(['scripts/prepare-local-language-test-assets.mjs']);
process.exitCode = assets || await run(['node_modules/@playwright/test/cli.js', 'test', '--config=playwright.workspace-language.config.ts', ...process.argv.slice(2)]);
