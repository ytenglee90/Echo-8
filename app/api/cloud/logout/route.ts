import { logoutRoute } from '@/src/server/cloud/routes.ts';

export const runtime = 'edge';

export async function POST(): Promise<Response> {
  return logoutRoute();
}
