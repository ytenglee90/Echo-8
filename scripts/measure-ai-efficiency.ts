import { writeFile } from 'node:fs/promises';
import { buildGenerateRequest } from '../src/plugins/ai-assistant/generation-request.ts';
import { estimateAITokens } from '../src/plugins/ai-assistant/evidence-boundaries.ts';
import { buildProviderRequest } from '../src/plugins/ai-provider/provider-transport.ts';
import { efficiencyContext, efficiencyScenarios } from '../tests/fixtures/ai-efficiency-scenarios.ts';

const rows = [];
const encoder = new TextEncoder();
const profile = { id: 'fixture', label: 'Fixture', platform: 'Fixture', endpoint: 'https://api.deepseek.com', model: 'fixture',
  authentication: 'none', apiStyle: 'openai' } as const;
for (const scenario of efficiencyScenarios) {
  let input = 0;
  let requestBytes = 0;
  let outputTokenLimit = 0;
  for (const prepared of scenario.rounds) {
    const request = await buildGenerateRequest(efficiencyContext, prepared, { templates: [] });
    const { init } = buildProviderRequest(profile, '', request, true);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    requestBytes += encoder.encode(String(init.body)).length;
    outputTokenLimit += request.maxOutputTokens;
    input += 3 + request.messages.reduce((sum, message) => sum + 4 + estimateAITokens(message.content) +
      (message.toolCalls?.length ? estimateAITokens(JSON.stringify(message.toolCalls)) : 0), 0) +
      (body.tools ? estimateAITokens(JSON.stringify(body.tools)) : 0) +
      (body.response_format ? estimateAITokens(JSON.stringify(body.response_format)) : 0);
  }
  rows.push({ scenario: scenario.name, calls: scenario.rounds.length, estimatedInput: input, requestBytes, outputTokenLimit });
}
const report = { measurement: 'fixed request replay, serialized DeepSeek body bytes and estimated input tokens; no network calls or paid usage', scenarios: rows };
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
