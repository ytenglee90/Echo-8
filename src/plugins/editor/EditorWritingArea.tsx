'use client';

import {
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import { isAbortError } from '../../services/abort.ts';
import { countNonWhitespaceGraphemes, countWritingUnits } from '../../services/text-metrics.ts';
import {
  ANNOTATION_TEXT_CLIPBOARD_MIME,
  type AnnotationClipboardItem,
  type AnnotationRecord,
} from '../../protocols/annotations.ts';
import type { EditorRevealRequest, WritingActivityKind } from '../../protocols/editor.ts';
import type {
  TextAssistAnalysis,
  TextAssistAnalyzeRequest,
  TextAssistDecoration,
  TextCompletionCandidate,
  TextNodeReferenceTarget,
  TextAssistSettings,
} from '../../protocols/text-assist.ts';
import type { TextDocumentFormat, TextFormatMark } from '../../protocols/formatting.ts';
import { resolveFormatAtOffset } from './format-target.ts';
import {
  EditorAnnotationMarkers,
  TextAssistMenuView,
  type TextAssistMenu,
} from './EditorAssistOverlays.tsx';
import type { TextAssistRuntime } from './EditorFormatBar.tsx';
import {
  caretAssistPosition,
  type DOMTextSelection,
  pointerAssistPosition,
  readPlainText,
  readSelectionRange,
  restoreSelectionRange,
  selectionScreenAnchor,
  textOffsetFromClientPoint,
} from './dom-text-selection.ts';
import { editorDocumentTextColor, writeFormattedText } from './formatted-text-dom.ts';
import {
  collectAnnotationClipboardItems,
  decodeAnnotationClipboard,
  encodeAnnotationClipboard,
  moveEditorAnnotationRecords,
  readRememberedAnnotationClipboard,
  rebaseEditorAnnotationRecords,
  rememberAnnotationClipboard,
} from './annotation-clipboard.ts';
import {
  createEditorViewId,
  type EditorBodyEdit as BodyEdit,
  type EditorSelectionPreview as SelectionPreview,
} from './editor-runtime.ts';
import {
  calculateTextDelta,
  classifyWritingInput,
  planTextRangeMove,
  type TextDelta,
} from './text-edit.ts';
import {
  moveTextAssistCompletionSelection,
  rebaseTextAssistAnalysis,
  stabilizeTextAssistAnalysis,
} from './text-assist-state.ts';

const TEXT_ASSIST_WINDOW = 16 * 1024;
export function PlainTextWritingArea({
  client,
  nodeId,
  revision,
  body,
  format,
  marks,
  windowStart,
  label,
  onPreview,
  onEdit,
  onSelection,
  onWindowBoundary,
  revealRequest,
  textAssist,
}: {
  client: ViewClient;
  nodeId: string;
  revision: number;
  body: string;
  format: TextDocumentFormat;
  marks: TextFormatMark[];
  windowStart: number;
  label: string;
  onPreview: (previous: string, next: string, delta?: TextDelta) => void;
  onEdit: (edit: BodyEdit) => Promise<void>;
  onSelection: (selection: Omit<SelectionPreview, 'id'>) => void;
  onWindowBoundary?: (direction: 'previous' | 'next') => boolean;
  revealRequest?: EditorRevealRequest;
  textAssist: TextAssistRuntime;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const onSelectionRef = useRef(onSelection);
  const localText = useRef(body);
  const composing = useRef(false);
  const compositionBase = useRef(body);
  const inputType = useRef('insertText');
  const typingSessionRef = useRef(createEditorViewId('typing'));
  const capabilityVersion = useSyncExternalStore(
    client.subscribeCapabilities,
    client.getCapabilityVersion,
    () => 0,
  );
  const [assistInput, setAssistInput] = useState(() => ({ text: body, cursor: windowStart }));
  const [assistance, setAssistance] = useState<TextAssistAnalysis>();
  const [assistAvailable, setAssistAvailable] = useState(false);
  const [completionAllowed, setCompletionAllowed] = useState(false);
  const [focused, setFocused] = useState(false);
  const [menu, setMenu] = useState<TextAssistMenu>();
  const [assistInvalidation, setAssistInvalidation] = useState(0);
  const [annotationLayoutRevision, setAnnotationLayoutRevision] = useState(0);
  const [projectionRetry, setProjectionRetry] = useState(0);
  const annotationMeasurementBlocked = useRef(false);
  const pendingAnnotationCommits = useRef(0);
  const annotationUnlockFrame = useRef<number | undefined>(undefined);
  const completionAllowedRef = useRef(completionAllowed);
  const focusedRef = useRef(focused);
  // Rebuilding the rich DOM projection can make different browser engines
  // relocate a collapsed selection into an arbitrary decorated span. Keep an
  // explicit caret authoritative until the next real input/navigation action.
  const pendingProgrammaticCaret = useRef<number | undefined>(undefined);
  const stableSelection = useRef<DOMTextSelection | undefined>(undefined);
  const draggedSelection = useRef<DOMTextSelection | undefined>(undefined);
  const editorTextDragActive = useRef(false);
  const suppressNextDragMutation = useRef(false);
  const annotationRecords = useRef<AnnotationRecord[]>([]);
  const scrollBeforeInput = useRef<EditorScrollPosition | undefined>(undefined);
  const pendingScrollRestore = useRef<EditorScrollPosition | undefined>(undefined);
  const focusRestore = useRef<{
    selection?: DOMTextSelection;
    scroll: EditorScrollPosition;
  } | undefined>(undefined);
  const correctionEnabled = textAssist.settings.correctionEnabled;
  const completionEnabled = textAssist.settings.completionEnabled;
  const visibleDecorations = useMemo(() => textAssist.available
    ? (assistance?.decorations.filter((decoration) =>
      decoration.kind !== 'correction' || textAssist.settings.correctionEnabled) ?? [])
    : [], [assistance?.decorations, textAssist.available, textAssist.settings.correctionEnabled]);
  const visibleCompletions = useMemo(() => textAssist.available
    ? (assistance?.completions.filter((candidate) => candidate.kind === 'correction'
      ? textAssist.settings.correctionEnabled
      : textAssist.settings.completionEnabled) ?? [])
    : [], [
      assistance?.completions,
      textAssist.available,
      textAssist.settings.completionEnabled,
      textAssist.settings.correctionEnabled,
    ]);
  const decorationKey = visibleDecorations
    .map((decoration) => `${decoration.id}:${decoration.start}:${decoration.end}`)
    .join('|') ?? '';
  const durableFormattingKey = JSON.stringify([format, marks]);
  const formattingKey = `${durableFormattingKey}|${decorationKey}`;
  const lastFormattingKey = useRef(formattingKey);
  const lastWindowStart = useRef(windowStart);
  const boundaryRequest = useRef<'previous' | 'next' | undefined>(undefined);
  const lastNativeInputAt = useRef(0);
  const projectionTimer = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);

  useEffect(() => {
    onSelectionRef.current = onSelection;
  }, [onSelection]);

  useEffect(() => {
    completionAllowedRef.current = completionAllowed;
  }, [completionAllowed]);

  useEffect(() => {
    focusedRef.current = focused;
  }, [focused]);

  useEffect(() => () => {
    if (annotationUnlockFrame.current !== undefined) {
      globalThis.cancelAnimationFrame?.(annotationUnlockFrame.current);
    }
    if (projectionTimer.current !== undefined) globalThis.clearTimeout(projectionTimer.current);
  }, []);

  useEffect(
    () => client.subscribeSignal('text.assist.invalidated', () => {
      setAssistInvalidation((value) => value + 1);
    }),
    [client],
  );

  useEffect(() => {
    const controller = new AbortController();
    const request = textAssistRequest(nodeId, revision, assistInput.text, windowStart, assistInput.cursor);
    void client.request<TextAssistAnalysis>('text.assist.analyze@2', request, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        setAssistAvailable(true);
        setAssistance((current) => stabilizeTextAssistAnalysis(current, result));
        setMenu((current) => {
          if (current && current.kind !== 'completion') return current;
          const candidates = filterTextAssistCompletions(result.completions, {
            correctionEnabled,
            completionEnabled,
          });
          if (!focusedRef.current || !completionAllowedRef.current || candidates.length === 0) {
            return undefined;
          }
          return {
            kind: 'completion',
            candidates,
            activeIndex: 0,
            ...caretAssistPosition(
              rootRef.current,
              shellRef.current,
              assistInput.cursor - windowStart,
            ),
          };
        });
      },
      (error) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setAssistAvailable(false);
        setAssistance(undefined);
        setMenu(undefined);
      },
    );
    return () => controller.abort();
  }, [
    assistInput,
    assistInvalidation,
    capabilityVersion,
    client,
    nodeId,
    revision,
    completionEnabled,
    correctionEnabled,
    windowStart,
  ]);

  useEffect(() => {
    const root = rootRef.current;
    if (composing.current) return;
    if (!root || (localText.current === body && lastFormattingKey.current === formattingKey &&
      lastWindowStart.current === windowStart)) return;
    const quietFor = performance.now() - lastNativeInputAt.current;
    // React preview props can trail the local contenteditable buffer by one or
    // more keystrokes. Never replace the active DOM with that older projection
    // during a typing burst; reconcile once the event batch has settled.
    if (focusedRef.current && quietFor < 120) {
      if (projectionTimer.current !== undefined) globalThis.clearTimeout(projectionTimer.current);
      projectionTimer.current = globalThis.setTimeout(() => {
        projectionTimer.current = undefined;
        setProjectionRetry((value) => value + 1);
      }, Math.max(16, 120 - quietFor));
      return;
    }
    if (projectionTimer.current !== undefined) {
      globalThis.clearTimeout(projectionTimer.current);
      projectionTimer.current = undefined;
    }
    const previousWindowStart = lastWindowStart.current;
    const requestedCaret = pendingProgrammaticCaret.current;
    const selection = requestedCaret === undefined
      ? (focusedRef.current ? stableSelection.current ?? readSelectionRange(root) : readSelectionRange(root))
      : { start: requestedCaret, end: requestedCaret, text: '' };
    const textChanged = localText.current !== body || lastWindowStart.current !== windowStart;
    const scroll = pendingScrollRestore.current ?? captureEditorScroll(root);
    writeFormattedText(root, body, format, marks, windowStart, visibleDecorations);
    setAnnotationLayoutRevision((value) => value + 1);
    localText.current = body;
    lastFormattingKey.current = formattingKey;
    lastWindowStart.current = windowStart;
    boundaryRequest.current = undefined;
    if (textChanged) {
      setAssistInput({
        text: body,
        cursor: windowStart + Math.max(0, Math.min(body.length, selection?.end ?? 0)),
      });
    }
    if (previousWindowStart !== windowStart) {
      root.scrollTop = windowStart > previousWindowStart
        ? Math.min(8, Math.max(0, root.scrollHeight - root.clientHeight))
        : Math.max(0, root.scrollHeight - root.clientHeight - 8);
    } else if (selection) restoreSelectionRange(
      root,
      selection.start,
      selection.end,
      requestedCaret === undefined ? 'before' : 'after',
    );
    if (previousWindowStart === windowStart) restoreEditorScroll(root, scroll);
  }, [body, durableFormattingKey, format, formattingKey, marks, projectionRetry, visibleDecorations, windowStart]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !revealRequest || revealRequest.id.length === 0) return;
    const localStart = revealRequest.start - windowStart;
    const localEnd = revealRequest.end - windowStart;
    if (localStart < 0 || localEnd > localText.current.length || localStart >= localEnd) return;
    const frame = globalThis.requestAnimationFrame?.(() => {
      root.focus({ preventScroll: true });
      const range = restoreSelectionRange(root, localStart, localEnd);
      if (!range) return;
      const rootRect = root.getBoundingClientRect();
      const rangeRect = range.getBoundingClientRect();
      root.scrollTop = Math.max(
        0,
        root.scrollTop + rangeRect.top - rootRect.top - (rootRect.height - rangeRect.height) / 2,
      );
      publishSelection(root, windowStart, onSelectionRef.current);
    });
    return () => {
      if (frame !== undefined) globalThis.cancelAnimationFrame?.(frame);
    };
  }, [revealRequest, windowStart]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || root.childNodes.length > 0) return;
    writeFormattedText(root, body, format, marks, windowStart, visibleDecorations);
    localText.current = body;
    lastFormattingKey.current = formattingKey;
    lastWindowStart.current = windowStart;
  }, [body, durableFormattingKey, format, formattingKey, marks, visibleDecorations, windowStart]);

  const publishCurrentSelection = (focusOverride = focusedRef.current) => {
    const selection = readSelectionRange(rootRef.current);
    if (!selection) return;
    stableSelection.current = selection;
    onSelection({
      start: windowStart + selection.start,
      end: windowStart + selection.end,
      characters: countNonWhitespaceGraphemes(selection.text),
      writingUnits: countWritingUnits(selection.text),
      focused: focusOverride,
      screenAnchor: selectionScreenAnchor(rootRef.current),
    });
    setAssistInput((current) => {
      const cursor = windowStart + selection.end;
      return current.cursor === cursor ? current : { text: current.text, cursor };
    });
    if (selection.start !== selection.end) {
      setCompletionAllowed(false);
      setMenu((current) => current?.kind === 'completion' ? undefined : current);
    }
  };

  const blockAnnotationMeasurement = () => {
    if (annotationUnlockFrame.current !== undefined) {
      globalThis.cancelAnimationFrame?.(annotationUnlockFrame.current);
      annotationUnlockFrame.current = undefined;
    }
    annotationMeasurementBlocked.current = true;
  };

  const takeEditorScroll = (root: HTMLDivElement) => {
    const scroll = scrollBeforeInput.current ?? captureEditorScroll(root);
    scrollBeforeInput.current = undefined;
    pendingScrollRestore.current = scroll;
    return scroll;
  };

  const commitEdit = (edit: BodyEdit) => {
    blockAnnotationMeasurement();
    const previousAnnotationRecords = annotationRecords.current;
    if (edit.move) {
      annotationRecords.current = moveEditorAnnotationRecords(
        previousAnnotationRecords,
        nodeId,
        windowStart + edit.move.start,
        windowStart + edit.move.end,
        windowStart + edit.move.target,
      );
    } else if (edit.delta) {
      annotationRecords.current = rebaseEditorAnnotationRecords(
        previousAnnotationRecords,
        nodeId,
        windowStart + edit.delta.start,
        edit.delta.deleteCount,
        edit.delta.insert.length,
      );
    }
    pendingAnnotationCommits.current += 1;
    const settle = () => {
      pendingAnnotationCommits.current = Math.max(0, pendingAnnotationCommits.current - 1);
      if (pendingAnnotationCommits.current > 0 || composing.current) return;
      const unlock = () => {
        annotationUnlockFrame.current = undefined;
        if (pendingAnnotationCommits.current > 0 || composing.current) return;
        if (rootRef.current && pendingScrollRestore.current) {
          restoreEditorScroll(rootRef.current, pendingScrollRestore.current);
        }
        pendingScrollRestore.current = undefined;
        annotationMeasurementBlocked.current = false;
        setAnnotationLayoutRevision((value) => value + 1);
      };
      const frame = globalThis.requestAnimationFrame?.(unlock);
      if (frame === undefined) queueMicrotask(unlock);
      else annotationUnlockFrame.current = frame;
    };
    try {
      void onEdit(edit).then(settle, () => {
        annotationRecords.current = previousAnnotationRecords;
        settle();
      });
    } catch {
      annotationRecords.current = previousAnnotationRecords;
      settle();
    }
  };

  const handleInput = () => {
    const root = rootRef.current;
    if (!root) return;
    const scroll = takeEditorScroll(root);
    if (suppressNextDragMutation.current || editorTextDragActive.current || inputType.current === 'deleteByDrag') {
      const dragStillActive = editorTextDragActive.current;
      suppressNextDragMutation.current = false;
      // The editor owns same-document moves through content.moveRange. Some
      // engines still perform the source-side native deletion even when the
      // controlled drop was prevented, and an external editable may request a
      // move. Restore the projection without publishing a second content edit:
      // internal drops remain one undoable transaction and external drops are
      // copies from this editor.
      const selection = stableSelection.current;
      writeFormattedText(
        root,
        localText.current,
        format,
        marks,
        windowStart,
        visibleDecorations,
      );
      setAnnotationLayoutRevision((value) => value + 1);
      if (root.ownerDocument.activeElement === root && selection) {
        restoreSelectionRange(root, selection.start, selection.end, 'before');
      }
      restoreEditorScroll(root, scroll);
      pendingScrollRestore.current = undefined;
      if (!dragStillActive) inputType.current = 'insertText';
      return;
    }
    blockAnnotationMeasurement();
    lastNativeInputAt.current = performance.now();
    if (projectionTimer.current !== undefined) {
      globalThis.clearTimeout(projectionTimer.current);
      projectionTimer.current = undefined;
    }
    pendingProgrammaticCaret.current = undefined;
    const next = readPlainText(root);
    if (composing.current) {
      restoreEditorScroll(root, scroll);
      return;
    }
    const previous = localText.current;
    const delta = calculateTextDelta(previous, next);
    const selection = readSelectionRange(root) ?? stableSelection.current;
    const rebasedAssistance = rebaseTextAssistAnalysis(
      assistance,
      delta,
      windowStart,
    );
    setAssistance(rebasedAssistance);
    setMenu(undefined);
    // Firefox, WebKit and several IME paths may perform a native edit even
    // though ordinary typing is controlled above. At the end of a decorated
    // span, that edit can be inserted inside the span and inherit its node-link
    // underline/click target. Rebuild the derived projection immediately from
    // half-open text ranges, then put the caret after the decoration boundary.
    writeFormattedText(
      root,
      next,
      format,
      marks,
      windowStart,
      visibleTextAssistDecorations(rebasedAssistance, textAssist),
    );
    if (selection) {
      const collapsed = selection.start === selection.end;
      root.focus({ preventScroll: true });
      pendingProgrammaticCaret.current = collapsed ? selection.end : undefined;
      stableSelection.current = selection;
      restoreSelectionRange(root, selection.start, selection.end, collapsed ? 'after' : 'before');
    }
    restoreEditorScroll(root, scroll);
    localText.current = next;
    setAssistInput({ text: next, cursor: windowStart + (selection?.end ?? next.length) });
    setCompletionAllowed(/^insert(?:Text|ReplacementText)$/u.test(inputType.current));
    onPreview(previous, next, delta);
    commitEdit({
      previous,
      next,
      delta,
      kind: classifyWritingInput(inputType.current, delta),
      typingSessionId: typingSessionRef.current,
    });
  };

  const applyControlledInsertion = (
    insert: string,
    nextInputType: string,
    annotationCopies?: AnnotationClipboardItem[],
  ) => {
    const root = rootRef.current;
    if (!root) return;
    const scroll = takeEditorScroll(root);
    blockAnnotationMeasurement();
    lastNativeInputAt.current = performance.now();
    if (projectionTimer.current !== undefined) {
      globalThis.clearTimeout(projectionTimer.current);
      projectionTimer.current = undefined;
    }
    const previous = localText.current;
    const selection = readSelectionRange(root) ?? stableSelection.current ?? {
      start: previous.length,
      end: previous.length,
      text: '',
    };
    const start = Math.max(0, Math.min(previous.length, selection.start));
    const end = Math.max(start, Math.min(previous.length, selection.end));
    const next = `${previous.slice(0, start)}${insert}${previous.slice(end)}`;
    const delta: TextDelta = {
      start,
      deleteCount: end - start,
      deletedText: previous.slice(start, end),
      insert,
    };
    const rebasedAssistance = rebaseTextAssistAnalysis(
      assistance,
      { start, deleteCount: end - start, insert },
      windowStart,
    );
    const cursor = start + insert.length;
    setAssistance(rebasedAssistance);
    setMenu(undefined);
    setCompletionAllowed(/^insert(?:Text|ReplacementText)$/u.test(nextInputType));
    writeFormattedText(
      root,
      next,
      format,
      marks,
      windowStart,
      visibleTextAssistDecorations(rebasedAssistance, textAssist),
    );
    root.focus({ preventScroll: true });
    pendingProgrammaticCaret.current = cursor;
    stableSelection.current = { start: cursor, end: cursor, text: '' };
    restoreSelectionRange(root, cursor, cursor, 'after');
    restoreEditorScroll(root, scroll);
    localText.current = next;
    setAssistInput({ text: next, cursor: windowStart + cursor });
    inputType.current = nextInputType;
    onPreview(previous, next, delta);
    commitEdit({
      previous,
      next,
      delta,
      kind: classifyWritingInput(nextInputType, delta),
      typingSessionId: typingSessionRef.current,
      annotationCopies,
      ...(end > start || nextInputType === 'insertFromPaste'
        ? { inheritFormat: resolveFormatAtOffset(format, marks, windowStart + start) }
        : {}),
    });
    publishCurrentSelection();
  };

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    const dropped = event.dataTransfer.getData('text/plain').replace(/\r\n?/gu, '\n');
    if (!root || !dropped) return;
    const scroll = captureEditorScroll(root);
    pendingScrollRestore.current = scroll;
    event.preventDefault();
    event.stopPropagation();
    blockAnnotationMeasurement();
    lastNativeInputAt.current = performance.now();
    const previous = localText.current;
    const point = textOffsetFromClientPoint(root, event.clientX, event.clientY)
      ?? readSelectionRange(root)?.start
      ?? previous.length;
    const offset = Math.max(0, Math.min(previous.length, point));
    const internalSelection = draggedSelection.current;
    draggedSelection.current = undefined;
    editorTextDragActive.current = false;
    const internalMove = internalSelection && internalSelection.start < internalSelection.end &&
      previous.slice(internalSelection.start, internalSelection.end) === internalSelection.text
      ? planTextRangeMove(previous, internalSelection.start, internalSelection.end, offset)
      : undefined;
    if (internalSelection) {
      if (!internalMove) {
        root.focus({ preventScroll: true });
        restoreSelectionRange(root, internalSelection.start, internalSelection.end);
        restoreEditorScroll(root, scroll);
        publishCurrentSelection();
        return;
      }
      const rebasedAssistance = rebaseTextAssistAnalysis(assistance, internalMove.delta, windowStart);
      setAssistance(rebasedAssistance);
      setMenu(undefined);
      setCompletionAllowed(false);
      writeFormattedText(
        root,
        internalMove.next,
        format,
        marks,
        windowStart,
        visibleTextAssistDecorations(rebasedAssistance, textAssist),
      );
      root.focus({ preventScroll: true });
      pendingProgrammaticCaret.current = internalMove.cursor;
      stableSelection.current = { start: internalMove.cursor, end: internalMove.cursor, text: '' };
      restoreSelectionRange(root, internalMove.cursor, internalMove.cursor, 'after');
      restoreEditorScroll(root, scroll);
      localText.current = internalMove.next;
      setAssistInput({ text: internalMove.next, cursor: windowStart + internalMove.cursor });
      inputType.current = 'deleteByDrag';
      onPreview(previous, internalMove.next, internalMove.delta);
      commitEdit({
        previous,
        next: internalMove.next,
        delta: internalMove.delta,
        move: internalMove.move,
        kind: 'move',
        typingSessionId: typingSessionRef.current,
      });
      publishCurrentSelection();
      return;
    }
    const next = `${previous.slice(0, offset)}${dropped}${previous.slice(offset)}`;
    const annotationCopies = decodeAnnotationClipboard(
      event.dataTransfer.getData(ANNOTATION_TEXT_CLIPBOARD_MIME) ||
        readRememberedAnnotationClipboard(dropped),
      dropped,
    );
    const delta: TextDelta = { start: offset, deleteCount: 0, deletedText: '', insert: dropped };
    const inheritFormat = resolveFormatAtOffset(format, marks, windowStart + offset);
    const rebasedAssistance = rebaseTextAssistAnalysis(
      assistance,
      { start: offset, deleteCount: 0, insert: dropped },
      windowStart,
    );
    setAssistance(rebasedAssistance);
    setMenu(undefined);
    setCompletionAllowed(false);
    writeFormattedText(
      root,
      next,
      format,
      marks,
      windowStart,
      visibleTextAssistDecorations(rebasedAssistance, textAssist),
    );
    root.focus({ preventScroll: true });
    pendingProgrammaticCaret.current = offset + dropped.length;
    stableSelection.current = {
      start: offset + dropped.length,
      end: offset + dropped.length,
      text: '',
    };
    restoreSelectionRange(root, offset + dropped.length, offset + dropped.length);
    restoreEditorScroll(root, scroll);
    localText.current = next;
    setAssistInput({ text: next, cursor: windowStart + offset + dropped.length });
    inputType.current = 'insertFromDrop';
    onPreview(previous, next, delta);
    commitEdit({
      previous,
      next,
      delta,
      kind: 'paste',
      typingSessionId: typingSessionRef.current,
      inheritFormat,
      annotationCopies,
    });
    publishCurrentSelection();
  };

  const writeSelectionToClipboard = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root) return false;
    const selection = readSelectionRange(root) ?? stableSelection.current;
    if (!selection || selection.start === selection.end) return false;
    const previous = localText.current;
    const start = Math.max(0, Math.min(previous.length, selection.start));
    const end = Math.max(start, Math.min(previous.length, selection.end));
    if (start === end) return false;
    const text = previous.slice(start, end);
    const items = collectAnnotationClipboardItems(
      annotationRecords.current,
      nodeId,
      windowStart + start,
      windowStart + end,
    );
    event.clipboardData.setData('text/plain', text);
    const encoded = encodeAnnotationClipboard(text, items);
    rememberAnnotationClipboard(text, encoded);
    if (encoded) event.clipboardData.setData(ANNOTATION_TEXT_CLIPBOARD_MIME, encoded);
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  const handleCopy = (event: ReactClipboardEvent<HTMLDivElement>) => {
    writeSelectionToClipboard(event);
  };

  const handleCut = (event: ReactClipboardEvent<HTMLDivElement>) => {
    if (!writeSelectionToClipboard(event)) return;
    applyControlledInsertion('', 'deleteByCut');
  };

  const handlePaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const pasted = event.clipboardData.getData('text/plain').replace(/\r\n?/gu, '\n');
    event.preventDefault();
    event.stopPropagation();
    if (!pasted) return;
    const annotationCopies = decodeAnnotationClipboard(
      event.clipboardData.getData(ANNOTATION_TEXT_CLIPBOARD_MIME) ||
        readRememberedAnnotationClipboard(pasted),
      pasted,
    );
    applyControlledInsertion(pasted, 'insertFromPaste', annotationCopies);
  };

  const applyAssistReplacement = (
    start: number,
    end: number,
    replacement: string,
    kind: WritingActivityKind,
  ) => {
    const root = rootRef.current;
    if (!root) return;
    const scroll = takeEditorScroll(root);
    const localStart = start - windowStart;
    const localEnd = end - windowStart;
    const previous = localText.current;
    if (localStart < 0 || localEnd < localStart || localEnd > previous.length) return;
    blockAnnotationMeasurement();
    lastNativeInputAt.current = performance.now();
    const next = `${previous.slice(0, localStart)}${replacement}${previous.slice(localEnd)}`;
    const delta: TextDelta = {
      start: localStart,
      deleteCount: localEnd - localStart,
      deletedText: previous.slice(localStart, localEnd),
      insert: replacement,
    };
    const cursor = localStart + replacement.length;
    const inheritFormat = resolveFormatAtOffset(format, marks, start);
    const rebasedAssistance = rebaseTextAssistAnalysis(
      assistance,
      { start: localStart, deleteCount: localEnd - localStart, insert: replacement },
      windowStart,
    );
    setAssistance(rebasedAssistance);
    setMenu(undefined);
    setCompletionAllowed(false);
    writeFormattedText(
      root,
      next,
      format,
      marks,
      windowStart,
      visibleTextAssistDecorations(rebasedAssistance, textAssist),
    );
    // Focus first: Safari/Firefox may otherwise replace a programmatically
    // restored selection while focusing the contenteditable. Bias the collapsed
    // caret after a generated decoration so subsequent input cannot inherit its
    // jump target or underline.
    root.focus({ preventScroll: true });
    pendingProgrammaticCaret.current = cursor;
    stableSelection.current = { start: cursor, end: cursor, text: '' };
    restoreSelectionRange(root, cursor, cursor, 'after');
    restoreEditorScroll(root, scroll);
    localText.current = next;
    setAssistInput({ text: next, cursor: windowStart + cursor });
    onPreview(previous, next, delta);
    commitEdit({
      previous,
      next,
      delta,
      kind,
      typingSessionId: typingSessionRef.current,
      inheritFormat,
    });
    publishCurrentSelection();
  };

  const jumpToNode = (target: TextNodeReferenceTarget) => {
    setMenu(undefined);
    setCompletionAllowed(false);
    void (async () => {
      await client.dispatch('selection.set', {
        items: [{ id: target.id, kind: 'text-node' }],
        mode: 'replace',
      });
      await client.dispatch('canvas.focusSelection');
    })().catch(() => undefined);
  };

  const handleAssistPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-text-assist-id]')
      : undefined;
    const id = target?.dataset.textAssistId;
    if (!id) {
      pendingProgrammaticCaret.current = undefined;
      return;
    }
    const decoration = visibleDecorations.find((item) => item.id === id);
    if (!decoration) return;
    event.preventDefault();
    event.stopPropagation();
    const position = pointerAssistPosition(event.clientX, event.clientY, shellRef.current);
    setCompletionAllowed(false);
    if (decoration.kind === 'node-reference' && decoration.targets.length === 1) {
      jumpToNode(decoration.targets[0]);
      return;
    }
    setMenu(decoration.kind === 'correction'
      ? { kind: 'correction', decoration, ...position }
      : { kind: 'node-reference', decoration, ...position });
  };

  const handleAssistKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || composing.current) return;
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLocaleLowerCase();
    const historyCommand = modifier && !event.altKey
      ? key === 'y' || (key === 'z' && event.shiftKey)
        ? 'history.redo'
        : key === 'z' ? 'history.undo' : undefined
      : undefined;
    if (historyCommand) {
      // Some WebKit builds apply native contenteditable history before the
      // delegated window shortcut has synchronized Echo-8's durable history.
      // Own the keyboard intent here, but still route the operation through
      // the one global history command—there is no editor-local history stack.
      event.preventDefault();
      event.stopPropagation();
      setMenu(undefined);
      setCompletionAllowed(false);
      void client.dispatch(historyCommand);
      return;
    }
    if (!menu) {
      if (/^(?:Arrow|Home|End|Page)/u.test(event.key)) pendingProgrammaticCaret.current = undefined;
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      completionAllowedRef.current = false;
      setMenu(undefined);
      setCompletionAllowed(false);
      return;
    }
    if (menu.kind !== 'completion') return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setMenu({
        ...menu,
        activeIndex: moveTextAssistCompletionSelection(
          menu.activeIndex,
          menu.candidates.length,
          direction,
        ),
      });
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      const candidate = menu.candidates[menu.activeIndex];
      if (candidate) applyAssistReplacement(
        candidate.replaceStart,
        candidate.replaceEnd,
        candidate.insertText,
        candidate.replaceStart === candidate.replaceEnd ? 'insert' : 'replace',
      );
    }
  };

  const style = {
    '--editor-font-size': `${format.fontSize}px`,
    '--editor-font-weight': String(format.fontWeight),
    '--editor-line-height': String(format.lineHeight),
    '--editor-letter-spacing': `${format.letterSpacing}px`,
    '--editor-text-color': editorDocumentTextColor(format.color),
    '--editor-first-indent': `${format.firstLineIndent}em`,
    '--editor-paragraph-spacing': `${format.paragraphSpacing}em`,
  } as CSSProperties;

  return (
    <div ref={shellRef} className="editor-writing-shell">
      <div
        ref={rootRef}
        className="editor-writing-area"
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        role="textbox"
        aria-label={label}
        aria-multiline="true"
        aria-autocomplete="list"
        spellCheck={assistAvailable && textAssist.settings.correctionEnabled}
        style={style}
        onBeforeInput={(event: FormEvent<HTMLDivElement>) => {
          const nativeEvent = event.nativeEvent as InputEvent;
          const inputTypeValue = nativeEvent.inputType || 'insertText';
          if (inputTypeValue === 'deleteByDrag') {
            // Source deletion is either part of the controlled move handled by
            // onDrop, or an external drop which has copy semantics.
            event.preventDefault();
            inputType.current = inputTypeValue;
            return;
          }
          suppressNextDragMutation.current = false;
          blockAnnotationMeasurement();
          // Some browsers treat plaintext-only as ordinary contenteditable and
          // execute native rich-text commands. Durable formatting belongs to
          // Echo-8 commands, so prevent browser-only formatting from diverging
          // the DOM projection from the document model.
          if (/^format/u.test(inputTypeValue) ||
            inputTypeValue === 'insertOrderedList' || inputTypeValue === 'insertUnorderedList') {
            event.preventDefault();
            return;
          }
          if (rootRef.current) scrollBeforeInput.current = captureEditorScroll(rootRef.current);
          const isLineBreak = inputTypeValue === 'insertParagraph' || inputTypeValue === 'insertLineBreak';
          const isTextInsertion = (inputTypeValue === 'insertText' || inputTypeValue === 'insertReplacementText') &&
            typeof nativeEvent.data === 'string';
          if (!nativeEvent.isComposing && !composing.current && (isTextInsertion || isLineBreak)) {
            event.preventDefault();
            applyControlledInsertion(
              isLineBreak ? '\n' : nativeEvent.data!,
              inputTypeValue,
            );
            return;
          }
          if (pendingProgrammaticCaret.current !== undefined && rootRef.current) {
            restoreSelectionRange(
              rootRef.current,
              pendingProgrammaticCaret.current,
              pendingProgrammaticCaret.current,
              'after',
            );
          }
          inputType.current = inputTypeValue;
        }}
        onInput={handleInput}
        onCopy={handleCopy}
        onCut={handleCut}
        onPaste={handlePaste}
        onKeyDown={handleAssistKeyDown}
        onPointerDown={handleAssistPointerDown}
        onCompositionStart={() => {
          pendingProgrammaticCaret.current = undefined;
          composing.current = true;
          compositionBase.current = localText.current;
          setMenu(undefined);
          setCompletionAllowed(false);
        }}
        onCompositionEnd={() => {
          const root = rootRef.current;
          if (!root) return;
          const scroll = takeEditorScroll(root);
          const next = readPlainText(root);
          const previous = compositionBase.current;
          const selection = readSelectionRange(root) ?? stableSelection.current;
          const delta = calculateTextDelta(previous, next);
          const rebasedAssistance = rebaseTextAssistAnalysis(
            assistance,
            delta,
            windowStart,
          );
          composing.current = false;
          setAssistance(rebasedAssistance);
          setMenu(undefined);
          writeFormattedText(
            root,
            next,
            format,
            marks,
            windowStart,
            visibleTextAssistDecorations(rebasedAssistance, textAssist),
          );
          if (selection) {
            const collapsed = selection.start === selection.end;
            root.focus({ preventScroll: true });
            pendingProgrammaticCaret.current = collapsed ? selection.end : undefined;
            stableSelection.current = selection;
            restoreSelectionRange(root, selection.start, selection.end, collapsed ? 'after' : 'before');
          }
          restoreEditorScroll(root, scroll);
          localText.current = next;
          setAssistInput({ text: next, cursor: windowStart + (selection?.end ?? next.length) });
          setCompletionAllowed(true);
          onPreview(previous, next, delta);
          commitEdit({ previous, next, delta, kind: 'composition', typingSessionId: typingSessionRef.current });
        }}
        onFocus={() => {
          const root = rootRef.current;
          const restore = focusRestore.current;
          if (root && restore) {
            if (restore.selection) {
              stableSelection.current = restore.selection;
              restoreSelectionRange(
                root,
                restore.selection.start,
                restore.selection.end,
                restore.selection.start === restore.selection.end ? 'after' : 'before',
              );
            }
            restoreEditorScroll(root, restore.scroll);
            focusRestore.current = undefined;
          }
          typingSessionRef.current = createEditorViewId('typing');
          focusedRef.current = true;
          setFocused(true);
          publishCurrentSelection(true);
        }}
        onBlur={() => {
          const root = rootRef.current;
          const selection = readSelectionRange(root) ?? stableSelection.current;
          if (selection) stableSelection.current = selection;
          if (root) focusRestore.current = { selection, scroll: captureEditorScroll(root) };
          typingSessionRef.current = createEditorViewId('typing');
          focusedRef.current = false;
          publishCurrentSelection(false);
          setFocused(false);
          setMenu(undefined);
          setCompletionAllowed(false);
        }}
        onSelect={() => publishCurrentSelection()}
        onKeyUp={() => publishCurrentSelection()}
        onPointerUp={() => {
          setCompletionAllowed(false);
          publishCurrentSelection();
        }}
        onDragStart={(event) => {
          const selection = readSelectionRange(rootRef.current) ?? stableSelection.current;
          if (!selection || selection.start === selection.end) {
            draggedSelection.current = undefined;
            editorTextDragActive.current = false;
            suppressNextDragMutation.current = false;
            return;
          }
          const text = localText.current.slice(selection.start, selection.end);
          draggedSelection.current = { ...selection, text };
          editorTextDragActive.current = true;
          suppressNextDragMutation.current = true;
          event.dataTransfer.effectAllowed = 'copyMove';
          event.dataTransfer.setData('text/plain', text);
          const items = collectAnnotationClipboardItems(
            annotationRecords.current,
            nodeId,
            windowStart + selection.start,
            windowStart + selection.end,
          );
          const encoded = encodeAnnotationClipboard(text, items);
          rememberAnnotationClipboard(text, encoded);
          if (encoded) event.dataTransfer.setData(ANNOTATION_TEXT_CLIPBOARD_MIME, encoded);
        }}
        onDragEnd={() => {
          draggedSelection.current = undefined;
          editorTextDragActive.current = false;
          if (inputType.current === 'deleteByDrag') inputType.current = 'insertText';
        }}
        onScroll={(event) => {
          setMenu(undefined);
          if (!onWindowBoundary || boundaryRequest.current) return;
          const root = event.currentTarget;
          if (root.scrollHeight <= root.clientHeight + 2) return;
          const direction = root.scrollTop <= 2
            ? 'previous'
            : root.scrollHeight - root.clientHeight - root.scrollTop <= 2
              ? 'next'
              : undefined;
          if (direction && onWindowBoundary(direction)) boundaryRequest.current = direction;
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('text/plain')) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = draggedSelection.current ? 'move' : 'copy';
        }}
        onDrop={handleDrop}
      />
      <EditorAnnotationMarkers
        client={client}
        nodeId={nodeId}
        rootRef={rootRef}
        shellRef={shellRef}
        windowStart={windowStart}
        windowLength={body.length}
        layoutRevision={annotationLayoutRevision}
        measurementBlockedRef={annotationMeasurementBlocked}
        recordsRef={annotationRecords}
      />
      {menu && (
        <TextAssistMenuView
          menu={menu}
          onChooseCompletion={(candidate) => applyAssistReplacement(
            candidate.replaceStart,
            candidate.replaceEnd,
            candidate.insertText,
            candidate.replaceStart === candidate.replaceEnd ? 'insert' : 'replace',
          )}
          onChooseCorrection={(decoration, replacement) => applyAssistReplacement(
            decoration.start,
            decoration.end,
            replacement,
            'replace',
          )}
          onChooseReference={jumpToNode}
          onActiveCompletion={(activeIndex) => {
            if (menu.kind === 'completion') setMenu({ ...menu, activeIndex });
          }}
        />
      )}
      {assistAvailable && assistance && (
        <span className="sr-only" aria-live="polite">
          {visibleDecorations.filter((item) => item.kind === 'correction').length} 处文字建议，
          {visibleCompletions.length} 个候选
        </span>
      )}
    </div>
  );
}

function filterTextAssistCompletions(
  candidates: TextCompletionCandidate[],
  settings: TextAssistSettings,
): TextCompletionCandidate[] {
  return candidates.filter((candidate) => candidate.kind === 'correction'
    ? settings.correctionEnabled
    : settings.completionEnabled);
}

function visibleTextAssistDecorations(
  analysis: TextAssistAnalysis | undefined,
  runtime: TextAssistRuntime,
): TextAssistDecoration[] {
  if (!runtime.available) return [];
  return analysis?.decorations.filter((decoration) =>
    decoration.kind !== 'correction' || runtime.settings.correctionEnabled) ?? [];
}

function publishSelection(
  root: HTMLDivElement | null,
  windowStart: number,
  callback: (selection: Omit<SelectionPreview, 'id'>) => void,
): void {
  const selection = readSelectionRange(root);
  if (!selection) return;
  callback({
    start: windowStart + selection.start,
    end: windowStart + selection.end,
    characters: countNonWhitespaceGraphemes(selection.text),
    writingUnits: countWritingUnits(selection.text),
    screenAnchor: selectionScreenAnchor(root),
  });
}

interface EditorScrollPosition {
  top: number;
  left: number;
}

function captureEditorScroll(root: HTMLDivElement): EditorScrollPosition {
  return { top: root.scrollTop, left: root.scrollLeft };
}

function restoreEditorScroll(root: HTMLDivElement, position: EditorScrollPosition): void {
  root.scrollTop = position.top;
  root.scrollLeft = position.left;
}

function textAssistRequest(
  nodeId: string,
  revision: number,
  text: string,
  windowStart: number,
  cursor: number,
): TextAssistAnalyzeRequest {
  const localCursor = Math.max(0, Math.min(text.length, cursor - windowStart));
  let start = Math.max(0, localCursor - Math.floor(TEXT_ASSIST_WINDOW / 2));
  let end = Math.min(text.length, start + TEXT_ASSIST_WINDOW);
  start = Math.max(0, end - TEXT_ASSIST_WINDOW);
  end = Math.max(start, end);
  return {
    nodeId,
    revision,
    text: text.slice(start, end),
    windowStart: windowStart + start,
    cursor: windowStart + localCursor,
    maxDecorations: 240,
    maxCompletions: 8,
  };
}
