import type { Route } from '@playwright/test';
import { semanticModelFixture } from '../../tests/helpers/semantic-model-fixture.ts';

/** Existing action-mapping scenarios count their mapping requests; the dedicated semantic scenarios count all network stages. */
export async function fulfillSemanticDecomposition(route: Route): Promise<boolean> {
  if (route.request().method() === 'OPTIONS') return false;
  const output = semanticModelFixture(route.request().postDataJSON());
  if (!output) return false;
  await route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: {
    choices: [{ message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  } });
  return true;
}
