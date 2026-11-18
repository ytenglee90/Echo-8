import type { WorkspaceActionIndex, WorkspaceCoverageReport } from '../../protocols/workspace-actions.ts';
import { actionSources, type LocalAction } from './actions.ts';
import { workspaceCoverageCatalog } from './coverage-catalog.generated.ts';

const modelCategories = new Set(['A30', 'A31', 'A32', 'A33', 'A40', 'A44', 'A61', 'A62', 'A63']);
const remoteCategories = new Set(['A46', 'A47', 'A54', 'A55']);
const additional: Record<string, string[]> = {
  A02: ['viewport.set', 'viewport.scale'], A03: ['viewport.set', 'viewport.restore'], A04: ['viewport.set', 'viewport.focusEntity'],
  A05: ['viewport.read', 'viewport.restore', 'connection.graph'], A08: ['content.filter', 'entities.list', 'selection.set'],
  A14: ['node.create'], A16: ['content.extract.preview'], A18: ['node.resize'], A20: ['layout.inspect'],
  A26: ['connection.path'], A29: ['content.read'], A31: ['content.draft.preview'], A32: ['content.draft.preview'],
  A34: ['content.diff', 'editor.open'], A35: ['content.draft.preview'], A43: ['content.statistics'],
  A50: ['file.exportText', 'file.exportWord', 'file.result'], A51: ['file.copy', 'file.result'],
  A65: ['canvas.batch.preview', 'history.undo', 'history.redo'], A66: ['diagnostics.operations'],
  A45: ['clipboard.copy', 'clipboard.paste', 'clipboard.cut', 'clipboard.duplicate'],
};

const crossActions: Record<string, string[]> = {
  X04: ['content.find', 'clipboard.duplicate'],
  X08: ['registered:import-export:file.save-action', 'clipboard.duplicate'],
  X13: ['viewport.set', 'clipboard.duplicate'],
  X18: ['content.statistics', 'clipboard.duplicate'],
  X22: ['clipboard.duplicate', 'canvas.batch.preview', 'history.undo', 'history.redo'],
  X26: ['viewport.read', 'file.result', 'clipboard.duplicate'],
};

export function buildCoverage(index: WorkspaceActionIndex, definitions: LocalAction[]): WorkspaceCoverageReport {
  const registered = new Set([
    ...index.registry.commands.filter(entry => entry.available).map(entry => 'command:' + entry.type),
    ...index.registry.queries.filter(entry => entry.available).map(entry => 'query:' + entry.type),
    ...index.registry.capabilities.filter(entry => entry.providers.length).map(entry => 'capability:' + entry.key),
  ]);
  const sources = new Map(definitions.map(action => [action.descriptor.id, actionSources(action)]));
  return {
    version: 1,
    categories: workspaceCoverageCatalog.categories.map(category => {
      const matches = index.actions.filter(action => additional[category.id]?.includes(action.id) ||
        sources.get(action.id)?.some(source => (category.sourceKeys as readonly string[]).includes(source)));
      return { ...category, sourceKeys: [...category.sourceKeys],
        actions: matches.map(({ id, status }) => ({ id, status })),
        registered: category.sourceKeys.filter(key => registered.has(key)),
        missing: category.sourceKeys.filter(key => !registered.has(key)),
        acceptanceStatus: 'not-run' as const,
        limits: [modelCategories.has(category.id) ? 'requires-local-generative-model' : '',
          remoteCategories.has(category.id) ? 'remote-execution-disabled' : '',
          !matches.some(action => action.status === 'available') ? 'no-executable-adapter' : ''].filter(Boolean),
      };
    }),
    crossCategory: workspaceCoverageCatalog.crossCategory.map(entry => ({ ...entry, acceptanceStatus: 'not-run',
      actions: index.actions.filter(action => crossActions[entry.id]?.includes(action.id)).map(({ id, status }) => ({ id, status })),
    })),
    scenarios: workspaceCoverageCatalog.scenarios.map(entry => ({ ...entry, coverageIds: [...entry.coverageIds], acceptanceStatus: 'not-run' })),
    note: '目录映射不等于验收通过。固定计划的逐项结果在独立验收报告中登记；语义生成与远端效果不得以固定稿件或模拟结果替代。',
  };
}
