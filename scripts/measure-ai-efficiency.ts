import { writeFile } from 'node:fs/promises';
import { buildGenerateRequest } from '../src/plugins/ai-assistant/generation-request.ts';
import { estimateAITokens } from '../src/plugins/ai-assistant/evidence-boundaries.ts';
import { efficiencyContext, efficiencyScenarios } from '../tests/fixtures/ai-efficiency-scenarios.ts';

const rows = [];
for (const scenario of efficiencyScenarios) {
  let input = 0;
  for (const prepared of scenario.rounds) {
    const request = await buildGenerateRequest(efficiencyContext, prepared, { templates: [] });
    input += 3 + request.messages.reduce((sum, message) => sum + 4 + estimateAITokens(message.content), 0);
  }
  rows.push({ scenario: scenario.name, calls: scenario.rounds.length, estimatedInput: input });
}
const report = { measurement: 'local estimate of fixed request inputs; excludes unknown model outputs and paid billing', scenarios: rows };
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
