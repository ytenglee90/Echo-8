export interface MessageContract<TInput = unknown, TResult = unknown> {
  input: TInput;
  result: TResult;
}

type ValidatedMessage = MessageContract<unknown, unknown>;

/** Closed built-in query-name registry. Runtime handlers still validate every input. */
export interface ApplicationQueryMap {
  'ai.catalog': ValidatedMessage;
  'ai.memory.deleteConfirmation': ValidatedMessage;
  'ai.memoryCatalog': ValidatedMessage;
  'ai.pendingPreparation': ValidatedMessage;
  'ai.promptTemplates': ValidatedMessage;
  'ai.state': ValidatedMessage;
  'ai.transcript': ValidatedMessage;
  'aiProvider.state': ValidatedMessage;
  'cloudSync.deleteConfirmation': ValidatedMessage;
  'cloudSync.projects': ValidatedMessage;
  'cloudSync.state': ValidatedMessage;
  'commandPalette.state': ValidatedMessage;
  'diagnostics.state': ValidatedMessage;
  'editor.openPanes': ValidatedMessage;
  'editor.state': ValidatedMessage;
  'localSemanticProvider.state': ValidatedMessage;
  'palette.colorPicker.state': ValidatedMessage;
  'pluginCenter.state': ValidatedMessage;
  'shortcuts.state': ValidatedMessage;
  'semanticProvider.personalConnections': ValidatedMessage;
  'semanticProvider.state': ValidatedMessage;
  'system.actions': ValidatedMessage;
  'system.document.revision': ValidatedMessage;
  'system.persistence': ValidatedMessage;
  'system.personalAssets.get': ValidatedMessage;
  'system.plugins': ValidatedMessage;
  'system.preferences.get': ValidatedMessage;
  'system.project.source': ValidatedMessage;
  'system.recovery.list': ValidatedMessage;
  'system.recovery.preview': ValidatedMessage;
  'system.runtime': ValidatedMessage;
  'system.shortcuts': ValidatedMessage;
}

/** Closed built-in capability-name registry. Runtime providers remain the schema authority. */
export interface ApplicationCapabilityMap {
  'ai.generate.stream@1': ValidatedMessage;
  'ai.generate@1': ValidatedMessage;
  'ai.promptPolicy@1': ValidatedMessage;
  'ai.provider.catalog@1': ValidatedMessage;
  'annotations.forTarget@1': ValidatedMessage;
  'annotations.list@1': ValidatedMessage;
  'annotations.state@1': ValidatedMessage;
  'appearance.colors@1': ValidatedMessage;
  'appearance.read@1': ValidatedMessage;
  'appearance.resetPlan@1': ValidatedMessage;
  'appearance.updatePlan@1': ValidatedMessage;
  'assets.readText@1': ValidatedMessage;
  'canvas.appearance@1': ValidatedMessage;
  'canvas.camera@1': ValidatedMessage;
  'canvas.pointer@1': ValidatedMessage;
  'canvas.tool@1': ValidatedMessage;
  'canvas.viewport@1': ValidatedMessage;
  'canvas.viewportCenter@1': ValidatedMessage;
  'clipboard.instantiate@1': ValidatedMessage;
  'clipboard.serialize@1': ValidatedMessage;
  'clipboard.state@1': ValidatedMessage;
  'connections.appearance@1': ValidatedMessage;
  'connections.list@1': ValidatedMessage;
  'content.anchorMovePlan@1': ValidatedMessage;
  'content.anchorTransformPlan@1': ValidatedMessage;
  'content.annotationClonePlan@1': ValidatedMessage;
  'content.appendPlan@1': ValidatedMessage;
  'content.catalog@2': ValidatedMessage;
  'content.clonePlan@1': ValidatedMessage;
  'content.createPlan@1': ValidatedMessage;
  'content.deltaPlan@1': ValidatedMessage;
  'content.formatting@2': ValidatedMessage;
  'content.metrics@2': ValidatedMessage;
  'content.metrics@3': ValidatedMessage;
  'content.movePlan@1': ValidatedMessage;
  'content.placementPlan@1': ValidatedMessage;
  'content.read@1': ValidatedMessage;
  'content.renamePlan@1': ValidatedMessage;
  'content.replacePlan@2': ValidatedMessage;
  'content.search@2': ValidatedMessage;
  'content.statistics@1': ValidatedMessage;
  'content.summaries@1': ValidatedMessage;
  'content.summariesById@1': ValidatedMessage;
  'context.catalog@1': ValidatedMessage;
  'context.read@1': ValidatedMessage;
  'context.search@1': ValidatedMessage;
  'context.search@2': ValidatedMessage;
  'context.search@3': ValidatedMessage;
  'context.semanticSearch@1': ValidatedMessage;
  'editor.activeNode@1': ValidatedMessage;
  'editor.context@1': ValidatedMessage;
  'editor.metrics@1': ValidatedMessage;
  'editor.selection@1': ValidatedMessage;
  'entity.deletePlan@1': ValidatedMessage;
  'file.state@1': ValidatedMessage;
  'file.textExportState@1': ValidatedMessage;
  'file.chooseDirectoryNearProject@1': ValidatedMessage;
  'group.dropTarget@1': ValidatedMessage;
  'group.membership.state@1': ValidatedMessage;
  'groups.list@1': ValidatedMessage;
  'layout.gridPlan@1': ValidatedMessage;
  'layout.resizeSnap@1': ValidatedMessage;
  'layout.snap@1': ValidatedMessage;
  'palette.state@1': ValidatedMessage;
  'palette.targets@1': ValidatedMessage;
  'search.index.status@1': ValidatedMessage;
  'search.state@1': ValidatedMessage;
  'selection.entities@1': ValidatedMessage;
  'selection.read@1': ValidatedMessage;
  'selection.resolve@1': ValidatedMessage;
  'selection.scopeAt@1': ValidatedMessage;
  'statistics.contribute@1': ValidatedMessage;
  'statistics.selected@1': ValidatedMessage;
  'text.assist.analyze@2': ValidatedMessage;
  'text.assist.resources@3': ValidatedMessage;
  'text.assist.settings@1': ValidatedMessage;
}

export type KnownQueryType = Extract<keyof ApplicationQueryMap, string>;
export type KnownCapabilityType = Extract<keyof ApplicationCapabilityMap, string>;
