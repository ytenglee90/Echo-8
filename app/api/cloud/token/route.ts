import { dataTokenRoute } from '@/src/server/cloud/routes.ts';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return dataTokenRoute(request);
}
