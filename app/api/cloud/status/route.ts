import { cloudStatusRoute } from '@/src/server/cloud/routes.ts';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return cloudStatusRoute(request);
}
