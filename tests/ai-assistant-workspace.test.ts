import assert from 'node:assert/strict';
import test from 'node:test';
import type { AISessionRecord } from '../src/protocols/ai.ts';
import {
  AI_UI_NAMESPACE,
  buildAssistantWorkspacePatches,
  createAssistantInstance,
  createAssistantSession,
  readAssistantInstancesFromWorkspace,
  selectPrimaryAssistant,
} from '../src/plugins/ai-assistant/assistant-workspace.ts';

function session(id: string, createdAt = 1): AISessionRecord {
  return {
    id,
    title: id,
    revision: 1,
    turns: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

test('assistant workspace restores valid windows only and keeps per-session choices isolated', () => {
  const sessions = { first: session('first'), second: session('second') };
  const assistants = readAssistantInstancesFromWorkspace({
    sessions,
    sessionSettings: {
      first: { providerProfileId: 'provider:first', promptTemplateId: 'prompt:first' },
      second: {
        providerProfileId: 'provider:second',
        memorySourceIds: ['memory:second'],
        contextMode: 'explicit-only',
        autoMemoryCandidates: true,
      },
    },
    storedAssistants: [
      {
        id: 'assistant:first',
        sessionId: 'first',
        rect: { x: 20, y: 64, width: 520, height: 720 },
        composerHeight: 100,
        view: 'chat',
        createdAt: 1,
      },
      {
        id: 'assistant:second',
        sessionId: 'second',
        rect: { x: 48, y: 88, width: 520, height: 720 },
        composerHeight: 120,
        view: 'memory',
        providerProfileId: 'provider:explicit',
        createdAt: 2,
      },
      {
        id: 'assistant:orphan',
        sessionId: 'missing',
        rect: { x: 0, y: 0, width: 520, height: 720 },
        composerHeight: 100,
        view: 'chat',
        createdAt: 3,
      },
    ],
  });

  assert.equal(assistants.length, 2);
  assert.equal(assistants[0]?.providerProfileId, 'provider:first');
  assert.equal(assistants[0]?.promptTemplateId, 'prompt:first');
  assert.equal(assistants[1]?.providerProfileId, 'provider:explicit');
  assert.deepEqual(assistants[1]?.memorySourceIds, ['memory:second']);
  assert.equal(assistants[1]?.contextMode, 'explicit-only');
  assert.equal(assistants[1]?.autoMemoryCandidates, true);
});

test('assistant workspace converts the legacy single-window state without creating document data', () => {
  const sessions = { legacy: session('legacy', 42) };
  const assistants = readAssistantInstancesFromWorkspace({
    sessions,
    storedAssistants: undefined,
    legacyOpen: true,
    legacySessionId: 'legacy',
    legacyPanelRect: { x: 60, y: 80, width: 640, height: 700 },
    legacyComposerHeight: 140,
    legacyView: 'provider',
  });

  assert.deepEqual(assistants, [{
    id: 'ai-assistant-primary',
    sessionId: 'legacy',
    rect: { x: 60, y: 80, width: 640, height: 700 },
    composerHeight: 140,
    view: 'provider',
    createdAt: 42,
  }]);
  assert.deepEqual(readAssistantInstancesFromWorkspace({
    sessions,
    storedAssistants: undefined,
    legacyOpen: false,
    legacySessionId: 'legacy',
  }), []);
});

test('assistant workspace patches stay personal, select the active window and prune deleted session settings', () => {
  const sessions = { first: session('first'), second: session('second') };
  const assistants = [
    createAssistantInstance({
      id: 'assistant:first',
      sessionId: 'first',
      inheritLayout: false,
      createdAt: 1,
      settings: { providerProfileId: 'provider:first' },
    }),
    {
      ...createAssistantInstance({
        id: 'assistant:second',
        sessionId: 'second',
        inheritLayout: false,
        createdAt: 2,
        settings: {
          memorySourceIds: ['memory:second'],
          contextMode: 'explicit-only',
          autoMemoryCandidates: true,
        },
      }),
      minimized: true,
    },
  ];
  const patches = buildAssistantWorkspacePatches(assistants, 'assistant:second', sessions, {
    missing: { providerProfileId: 'remove-me' },
  });

  assert.equal(patches.every((patch) => patch.domain === 'workspace'), true);
  assert.equal(patches.every((patch) => patch.namespace === AI_UI_NAMESPACE), true);
  assert.equal(patches.find((patch) => patch.key === 'open' && patch.op === 'set')?.value, true);
  assert.equal(patches.find((patch) => patch.key === 'activeSessionId' && patch.op === 'set')?.value, 'second');
  assert.deepEqual(
    patches.find((patch) => patch.key === 'sessionSettings' && patch.op === 'set')?.value,
    {
      first: { providerProfileId: 'provider:first' },
      second: {
        memorySourceIds: ['memory:second'],
        contextMode: 'explicit-only',
        autoMemoryCandidates: true,
      },
    },
  );
  assert.equal(selectPrimaryAssistant(assistants, 'assistant:second')?.sessionId, 'second');
});

test('assistant session and window factories are deterministic when identity and time are supplied', () => {
  assert.deepEqual(createAssistantSession(2, 'session:2', 100), {
    id: 'session:2',
    title: 'AI 对话 2',
    transcriptRevision: 0,
    transcriptLength: 0,
    transcriptEntries: 0,
    revision: 1,
    turns: 0,
    createdAt: 100,
    updatedAt: 100,
  });

  const assistant = createAssistantInstance({
    id: 'assistant:2',
    sessionId: 'session:2',
    offset: 2,
    inheritLayout: false,
    panelRect: { x: 1, y: 1, width: 1, height: 1 },
    composerHeight: 900,
    legacyView: 'provider',
    createdAt: 100,
  });
  assert.equal(assistant.view, 'chat');
  assert.deepEqual(assistant.rect, { x: 776, y: 124, width: 520, height: 720 });
  assert.equal(assistant.composerHeight, 76);
});
