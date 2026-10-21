import dataWorkerSource from '../../../cloud/data-worker/worker.js?raw';
import dataSchema from '../../../cloud/data-worker/schema.sql?raw';
import { CLOUD_DATA_WORKER_VERSION } from '../../cloud/contracts.ts';
import type { StoredInstallation } from './control-store.ts';
import { cloudflareApi } from './cloudflare-api.ts';

export interface ProvisionInput {
  installation: StoredInstallation;
  accessToken: string;
  dataSigningSecret: string;
  allowedOrigin: string;
  onProgress?: (installation: StoredInstallation) => Promise<void>;
}

export async function provisionInstallation(input: ProvisionInput): Promise<StoredInstallation> {
  const { installation, accessToken } = input;
  const accountPath = `/accounts/${encodeURIComponent(installation.accountId)}`;
  let d1DatabaseId = installation.d1DatabaseId;
  if (!d1DatabaseId) {
    const database = await cloudflareApi<{ uuid?: string }>(accessToken, `${accountPath}/d1/database`, {
      method: 'POST',
      body: JSON.stringify({ name: resourceName('echo8-data', installation.id, 63) }),
    });
    if (!database.uuid) throw new Error('Cloudflare 没有返回 D1 数据库编号');
    d1DatabaseId = database.uuid;
    await input.onProgress?.({ ...installation, d1DatabaseId });
  }

  const schemaStatements = dataSchema
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const sql of schemaStatements) {
    await cloudflareApi(accessToken, `${accountPath}/d1/database/${encodeURIComponent(d1DatabaseId)}/query`, {
      method: 'POST',
      body: JSON.stringify({ sql }),
    });
  }

  const metadata = {
    main_module: 'worker.js',
    compatibility_date: '2026-05-15',
    compatibility_flags: ['nodejs_compat'],
    bindings: [
      { type: 'd1', name: 'DB', database_id: d1DatabaseId },
      { type: 'plain_text', name: 'STORAGE_MODE', text: 'd1' },
      { type: 'plain_text', name: 'DATA_WORKER_VERSION', text: String(CLOUD_DATA_WORKER_VERSION) },
      { type: 'plain_text', name: 'INSTALLATION_ID', text: installation.id },
      { type: 'plain_text', name: 'ALLOWED_ORIGIN', text: new URL(input.allowedOrigin).origin },
      { type: 'secret_text', name: 'DATA_SIGNING_SECRET', text: input.dataSigningSecret },
    ],
  };
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
  form.set('worker.js', new Blob([dataWorkerSource], { type: 'application/javascript+module' }), 'worker.js');
  await cloudflareApi(accessToken, `${accountPath}/workers/scripts/${encodeURIComponent(installation.workerName)}`, {
    method: 'PUT',
    body: form,
  });
  await cloudflareApi(accessToken, `${accountPath}/workers/scripts/${encodeURIComponent(installation.workerName)}/subdomain`, {
    method: 'POST',
    body: JSON.stringify({ enabled: true, previews_enabled: false }),
  });
  const subdomain = await cloudflareApi<{ subdomain?: string }>(accessToken, `${accountPath}/workers/subdomain`);
  if (!subdomain.subdomain) throw new Error('该 Cloudflare 账户尚未设置 workers.dev 子域名');
  const workerUrl = `https://${installation.workerName}.${subdomain.subdomain}.workers.dev`;
  // The upload and subdomain API calls above are the authoritative deployment
  // checks. A Worker cannot reliably probe another workers.dev route in the
  // same account: Cloudflare may answer that internal public-route fetch with
  // a transient 404 even though the route is live for browsers.
  return {
    ...installation,
    d1DatabaseId,
    workerUrl,
    workerVersion: CLOUD_DATA_WORKER_VERSION,
    status: 'ready',
    error: undefined,
  };
}

function resourceName(prefix: string, id: string, maxLength: number): string {
  const suffix = id.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(-20) || crypto.randomUUID().slice(0, 12);
  return `${prefix}-${suffix}`.slice(0, maxLength).replace(/-+$/u, '');
}
