/** Legacy action-mapping fixtures model each supplied requirement as one independent control intent.
 * Dependency and text workflows use explicit, independently authored graphs in their own tests. */
export function semanticModelFixture(request: { messages: Array<{ content: string }> }): unknown | undefined {
  let payload: { stage?: string; requirements?: Array<{ id: string; text: string }> };
  try { payload = JSON.parse(request.messages[1]?.content ?? '{}'); } catch { return undefined; }
  if (payload.stage !== 'decompose') return undefined;
  return { version: 1, intents: payload.requirements!.map(req => ({ id: req.id, kind: 'control', request: req.text, objects: [], dependsOn: [] })),
    coverage: payload.requirements!.map(req => ({ requirementId: req.id, intentIds: [req.id] })), clarification: '' };
}
