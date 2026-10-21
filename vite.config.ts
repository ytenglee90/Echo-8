import { cloudflare } from '@cloudflare/vite-plugin';
import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig, type Plugin } from 'vite';

const workerSafeDynamicImport: Plugin = {
  name: 'echo8:worker-safe-dynamic-import',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const referrer = request.headers.referer ?? '';
      if (request.url?.split('?')[0] !== '/@vite/client' ||
        !referrer.includes('/src/plugins/local-semantic-provider/worker-jobs.ts')) {
        next();
        return;
      }
      // Vite 8 injects its whole page HMR client solely to obtain injectQuery
      // for a Blob-module import. That client is invalid in WorkerGlobalScope.
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/javascript');
      response.setHeader('Cache-Control', 'no-store');
      response.end('export function injectQuery(url) { return url; }');
    });
  },
};

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';
const isPlaywrightServer = process.env.PLAYWRIGHT_TEST === 'true';

// The hosted editor starts every built-in plugin, but large feature families do
// not need to live in one cache-invalidating entry module. Keep their execution
// order unchanged while giving browsers independently cacheable, parallel-fetch
// chunks. The portable build deliberately remains single-file in its own config.
const hostedClientChunking = {
  name: 'echo8:hosted-client-chunking',
  enforce: 'post' as const,
  config() {
    return {
      environments: {
        client: {
          build: {
            rolldownOptions: {
              output: {
                codeSplitting: {
                  minSize: 10_000,
                  groups: [
                    {
                      name: 'ai-workspace',
                      test: /[\\/]src[\\/]plugins[\\/](ai-assistant|ai-provider|local-semantic-provider)[\\/]/,
                    },
                    {
                      name: 'writing-workspace',
                      test: /[\\/]src[\\/]plugins[\\/](text-assist|text-node|editor)[\\/]/,
                    },
                    {
                      name: 'workspace-tools',
                      test: /[\\/]src[\\/]plugins[\\/](annotations|command-palette|diagnostic-center|import-export|palette|search-replace|shortcut-center|smart-layout|statistics)[\\/]/,
                    },
                  ],
                },
              },
            },
          },
        },
      },
    };
  },
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  return {
    css: { postcss: { plugins: [tailwindcss()] } },
    // Tests need a stable page, not hot-reload behavior. In particular, a
    // Vite HMR update is not meaningful inside the managed Web Worker.
    server: isPlaywrightServer
      ? { hmr: false }
      : isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : undefined,
    plugins: [
      workerSafeDynamicImport,
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
      }),
      hostedClientChunking,
    ],
  };
});
