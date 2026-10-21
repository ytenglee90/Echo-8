import type {
  TextAssistAnalysis,
  TextAssistDecoration,
} from '../../protocols/text-assist.ts';

export interface TextEditDelta {
  start: number;
  deleteCount: number;
  insert: string;
}

export function moveTextAssistCompletionSelection(
  activeIndex: number,
  candidateCount: number,
  direction: -1 | 1,
): number {
  if (!Number.isInteger(candidateCount) || candidateCount <= 0) return 0;
  const current = Number.isInteger(activeIndex) ? activeIndex : 0;
  return (current + direction + candidateCount) % candidateCount;
}

/**
 * Keeps unaffected derived marks in place while a fresh background analysis is pending.
 * Decorations touched by the edit are removed because their source text is no longer reliable.
 */
export function rebaseTextAssistAnalysis(
  analysis: TextAssistAnalysis | undefined,
  delta: TextEditDelta,
  editorWindowStart: number,
): TextAssistAnalysis | undefined {
  if (!analysis) return undefined;
  const editStart = editorWindowStart + delta.start;
  const editEnd = editStart + delta.deleteCount;
  const shift = delta.insert.length - delta.deleteCount;
  const analysisEnd = analysis.windowStart + analysis.windowLength;

  if (editEnd <= analysis.windowStart) {
    return {
      ...analysis,
      windowStart: analysis.windowStart + shift,
      decorations: analysis.decorations.map((item) => shiftDecoration(item, shift)),
      completions: [],
    };
  }
  if (editStart >= analysisEnd) {
    return analysis.completions.length === 0 ? analysis : { ...analysis, completions: [] };
  }

  const decorations = analysis.decorations.flatMap((item) => {
    if (item.end <= editStart) return [item];
    if (item.start >= editEnd) return [shiftDecoration(item, shift)];
    return [];
  });
  return {
    ...analysis,
    windowLength: Math.max(0, analysis.windowLength + shift),
    decorations,
    completions: [],
  };
}

export function stabilizeTextAssistAnalysis(
  current: TextAssistAnalysis | undefined,
  next: TextAssistAnalysis,
): TextAssistAnalysis {
  if (!current) return next;
  const decorations = decorationSignature(current.decorations) === decorationSignature(next.decorations)
    ? current.decorations
    : next.decorations;
  return decorations === next.decorations ? next : { ...next, decorations };
}

function shiftDecoration<T extends TextAssistDecoration>(decoration: T, shift: number): T {
  if (shift === 0) return decoration;
  return { ...decoration, start: decoration.start + shift, end: decoration.end + shift };
}

function decorationSignature(decorations: TextAssistDecoration[]): string {
  return JSON.stringify(decorations);
}
