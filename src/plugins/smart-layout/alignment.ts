import type { CanvasSnapGuide } from '../../protocols/canvas.ts';
import type { WorldBounds } from '../../protocols/viewport.ts';

export interface SnapReferenceBounds extends WorldBounds {
  id: string;
}

export interface CanvasSnapResult {
  offsetX: number;
  offsetY: number;
  guides: CanvasSnapGuide[];
}

export interface CanvasResizeSnapResult {
  width: number;
  height: number;
  guides: CanvasSnapGuide[];
}

interface AxisCandidate {
  delta: number;
  priority: number;
  guides: (shifted: WorldBounds) => CanvasSnapGuide[];
}

const MAX_SNAP_REFERENCES = 96;

/**
 * Calculates a view-only snap for one dragged selection bounds. The caller
 * converts its fixed screen-pixel threshold to world units before invoking it.
 */
export function snapDraggedBounds(
  dragged: WorldBounds,
  references: SnapReferenceBounds[],
  threshold: number,
): CanvasSnapResult {
  if (references.length === 0 || threshold <= 0) {
    return { offsetX: 0, offsetY: 0, guides: [] };
  }
  const nearby = nearestReferences(dragged, references);
  const xCandidates = alignmentXCandidates(dragged, nearby, threshold);
  const yCandidates = alignmentYCandidates(dragged, nearby, threshold);
  xCandidates.push(...spacingXCandidates(dragged, nearby, threshold));
  yCandidates.push(...spacingYCandidates(dragged, nearby, threshold));
  const x = bestCandidate(xCandidates);
  const y = bestCandidate(yCandidates);
  const shifted = {
    ...dragged,
    x: dragged.x + (x?.delta ?? 0),
    y: dragged.y + (y?.delta ?? 0),
  };
  return {
    offsetX: x?.delta ?? 0,
    offsetY: y?.delta ?? 0,
    guides: [...(x?.guides(shifted) ?? []), ...(y?.guides(shifted) ?? [])],
  };
}

/**
 * Snaps the moving right and bottom edges of a bottom-right resize handle.
 * The fixed left and top edges stay untouched, while every comparison remains
 * edge-based so resize previews never jump to centre or spacing candidates.
 */
export function snapResizedBounds(
  resized: WorldBounds,
  references: SnapReferenceBounds[],
  threshold: number,
): CanvasResizeSnapResult {
  if (references.length === 0 || threshold <= 0) {
    return { width: resized.width, height: resized.height, guides: [] };
  }
  const nearby = nearestReferences(resized, references);
  const resizedRight = right(resized);
  const resizedBottom = bottom(resized);
  const x = bestResizeEdgeCandidate(nearby.flatMap((reference) =>
    [reference.x, right(reference)].flatMap((target) => {
      const delta = target - resizedRight;
      if (Math.abs(delta) > threshold || resized.width + delta <= 0) return [];
      return [{
        delta,
        target,
        start: Math.min(resized.y, reference.y),
        end: Math.max(resizedBottom, bottom(reference)),
        referenceId: reference.id,
      }];
    })));
  const y = bestResizeEdgeCandidate(nearby.flatMap((reference) =>
    [reference.y, bottom(reference)].flatMap((target) => {
      const delta = target - resizedBottom;
      if (Math.abs(delta) > threshold || resized.height + delta <= 0) return [];
      return [{
        delta,
        target,
        start: Math.min(resized.x, reference.x),
        end: Math.max(resizedRight, right(reference)),
        referenceId: reference.id,
      }];
    })));
  return {
    width: resized.width + (x?.delta ?? 0),
    height: resized.height + (y?.delta ?? 0),
    guides: [
      ...(x ? [verticalGuide(x.target, x.start, x.end, 'edge')] : []),
      ...(y ? [horizontalGuide(y.target, y.start, y.end, 'edge')] : []),
    ],
  };
}

interface ResizeEdgeCandidate {
  delta: number;
  target: number;
  start: number;
  end: number;
  referenceId: string;
}

function bestResizeEdgeCandidate(candidates: ResizeEdgeCandidate[]): ResizeEdgeCandidate | undefined {
  return candidates.sort((left, rightCandidate) =>
    Math.abs(left.delta) - Math.abs(rightCandidate.delta) ||
    left.target - rightCandidate.target ||
    left.referenceId.localeCompare(rightCandidate.referenceId))[0];
}

function alignmentXCandidates(
  dragged: WorldBounds,
  references: SnapReferenceBounds[],
  threshold: number,
): AxisCandidate[] {
  const result: AxisCandidate[] = [];
  const movingEdges = [dragged.x, right(dragged)];
  for (const reference of references) {
    const referenceEdges = [reference.x, right(reference)];
    for (const moving of movingEdges) {
      for (const target of referenceEdges) {
        const delta = target - moving;
        if (Math.abs(delta) > threshold) continue;
        result.push({
          delta,
          priority: 0,
          guides: (shifted) => [verticalGuide(
            target,
            Math.min(shifted.y, reference.y),
            Math.max(bottom(shifted), bottom(reference)),
            'edge',
          )],
        });
      }
    }
    const target = centerX(reference);
    const delta = target - centerX(dragged);
    if (Math.abs(delta) <= threshold) {
      result.push({
        delta,
        priority: 1,
        guides: (shifted) => [verticalGuide(
          target,
          Math.min(shifted.y, reference.y),
          Math.max(bottom(shifted), bottom(reference)),
          'center',
        )],
      });
    }
  }
  return result;
}

function alignmentYCandidates(
  dragged: WorldBounds,
  references: SnapReferenceBounds[],
  threshold: number,
): AxisCandidate[] {
  const result: AxisCandidate[] = [];
  const movingEdges = [dragged.y, bottom(dragged)];
  for (const reference of references) {
    const referenceEdges = [reference.y, bottom(reference)];
    for (const moving of movingEdges) {
      for (const target of referenceEdges) {
        const delta = target - moving;
        if (Math.abs(delta) > threshold) continue;
        result.push({
          delta,
          priority: 0,
          guides: (shifted) => [horizontalGuide(
            target,
            Math.min(shifted.x, reference.x),
            Math.max(right(shifted), right(reference)),
            'edge',
          )],
        });
      }
    }
    const target = centerY(reference);
    const delta = target - centerY(dragged);
    if (Math.abs(delta) <= threshold) {
      result.push({
        delta,
        priority: 1,
        guides: (shifted) => [horizontalGuide(
          target,
          Math.min(shifted.x, reference.x),
          Math.max(right(shifted), right(reference)),
          'center',
        )],
      });
    }
  }
  return result;
}

function spacingXCandidates(
  dragged: WorldBounds,
  references: SnapReferenceBounds[],
  threshold: number,
): AxisCandidate[] {
  const result: AxisCandidate[] = [];
  for (let first = 0; first < references.length; first += 1) {
    for (let second = first + 1; second < references.length; second += 1) {
      const [left, rightReference] = references[first].x <= references[second].x
        ? [references[first], references[second]]
        : [references[second], references[first]];
      const gap = rightReference.x - right(left);
      if (gap < 0 || !sameHorizontalBand(dragged, left, rightReference)) continue;
      addSpacingXCandidate(result, dragged, threshold, left, rightReference, gap, 'after');
      addSpacingXCandidate(result, dragged, threshold, left, rightReference, gap, 'before');
      if (rightReference.x - right(left) >= dragged.width) {
        addSpacingXCandidate(result, dragged, threshold, left, rightReference, gap, 'between');
      }
    }
  }
  return result;
}

function addSpacingXCandidate(
  candidates: AxisCandidate[],
  dragged: WorldBounds,
  threshold: number,
  left: WorldBounds,
  rightReference: WorldBounds,
  gap: number,
  mode: 'before' | 'between' | 'after',
): void {
  const target = mode === 'after'
    ? right(rightReference) + gap
    : mode === 'before'
      ? left.x - gap - dragged.width
      : (right(left) + rightReference.x - dragged.width) / 2;
  const delta = target - dragged.x;
  if (Math.abs(delta) > threshold) return;
  candidates.push({
    delta,
    priority: 2,
    guides: (shifted) => {
      const y = Math.max(bottom(left), bottom(rightReference), bottom(shifted)) + Math.max(8, threshold / 2);
      if (mode === 'after') return [
        horizontalGuide(y, right(left), rightReference.x, 'spacing'),
        horizontalGuide(y, right(rightReference), shifted.x, 'spacing'),
      ];
      if (mode === 'before') return [
        horizontalGuide(y, right(shifted), left.x, 'spacing'),
        horizontalGuide(y, right(left), rightReference.x, 'spacing'),
      ];
      return [
        horizontalGuide(y, right(left), shifted.x, 'spacing'),
        horizontalGuide(y, right(shifted), rightReference.x, 'spacing'),
      ];
    },
  });
}

function spacingYCandidates(
  dragged: WorldBounds,
  references: SnapReferenceBounds[],
  threshold: number,
): AxisCandidate[] {
  const result: AxisCandidate[] = [];
  for (let first = 0; first < references.length; first += 1) {
    for (let second = first + 1; second < references.length; second += 1) {
      const [top, bottomReference] = references[first].y <= references[second].y
        ? [references[first], references[second]]
        : [references[second], references[first]];
      const gap = bottomReference.y - bottom(top);
      if (gap < 0 || !sameVerticalBand(dragged, top, bottomReference)) continue;
      addSpacingYCandidate(result, dragged, threshold, top, bottomReference, gap, 'after');
      addSpacingYCandidate(result, dragged, threshold, top, bottomReference, gap, 'before');
      if (bottomReference.y - bottom(top) >= dragged.height) {
        addSpacingYCandidate(result, dragged, threshold, top, bottomReference, gap, 'between');
      }
    }
  }
  return result;
}

function addSpacingYCandidate(
  candidates: AxisCandidate[],
  dragged: WorldBounds,
  threshold: number,
  top: WorldBounds,
  bottomReference: WorldBounds,
  gap: number,
  mode: 'before' | 'between' | 'after',
): void {
  const target = mode === 'after'
    ? bottom(bottomReference) + gap
    : mode === 'before'
      ? top.y - gap - dragged.height
      : (bottom(top) + bottomReference.y - dragged.height) / 2;
  const delta = target - dragged.y;
  if (Math.abs(delta) > threshold) return;
  candidates.push({
    delta,
    priority: 2,
    guides: (shifted) => {
      const x = Math.max(right(top), right(bottomReference), right(shifted)) + Math.max(8, threshold / 2);
      if (mode === 'after') return [
        verticalGuide(x, bottom(top), bottomReference.y, 'spacing'),
        verticalGuide(x, bottom(bottomReference), shifted.y, 'spacing'),
      ];
      if (mode === 'before') return [
        verticalGuide(x, bottom(shifted), top.y, 'spacing'),
        verticalGuide(x, bottom(top), bottomReference.y, 'spacing'),
      ];
      return [
        verticalGuide(x, bottom(top), shifted.y, 'spacing'),
        verticalGuide(x, bottom(shifted), bottomReference.y, 'spacing'),
      ];
    },
  });
}

function nearestReferences(dragged: WorldBounds, references: SnapReferenceBounds[]): SnapReferenceBounds[] {
  return [...references]
    .sort((left, rightReference) => {
      const leftDistance = Math.hypot(centerX(left) - centerX(dragged), centerY(left) - centerY(dragged));
      const rightDistance = Math.hypot(
        centerX(rightReference) - centerX(dragged),
        centerY(rightReference) - centerY(dragged),
      );
      return leftDistance - rightDistance || left.id.localeCompare(rightReference.id);
    })
    .slice(0, MAX_SNAP_REFERENCES);
}

function bestCandidate(candidates: AxisCandidate[]): AxisCandidate | undefined {
  return candidates.sort((left, rightCandidate) =>
    Math.abs(left.delta) - Math.abs(rightCandidate.delta) ||
    left.priority - rightCandidate.priority ||
    left.delta - rightCandidate.delta)[0];
}

function sameHorizontalBand(dragged: WorldBounds, first: WorldBounds, second: WorldBounds): boolean {
  return overlaps(dragged.y, bottom(dragged), first.y, bottom(first)) &&
    overlaps(dragged.y, bottom(dragged), second.y, bottom(second));
}

function sameVerticalBand(dragged: WorldBounds, first: WorldBounds, second: WorldBounds): boolean {
  return overlaps(dragged.x, right(dragged), first.x, right(first)) &&
    overlaps(dragged.x, right(dragged), second.x, right(second));
}

function overlaps(firstStart: number, firstEnd: number, secondStart: number, secondEnd: number): boolean {
  return firstStart <= secondEnd && firstEnd >= secondStart;
}

function verticalGuide(
  position: number,
  start: number,
  end: number,
  kind: CanvasSnapGuide['kind'],
): CanvasSnapGuide {
  return { orientation: 'vertical', position, start: Math.min(start, end), end: Math.max(start, end), kind };
}

function horizontalGuide(
  position: number,
  start: number,
  end: number,
  kind: CanvasSnapGuide['kind'],
): CanvasSnapGuide {
  return { orientation: 'horizontal', position, start: Math.min(start, end), end: Math.max(start, end), kind };
}

function right(bounds: WorldBounds): number {
  return bounds.x + bounds.width;
}

function bottom(bounds: WorldBounds): number {
  return bounds.y + bounds.height;
}

function centerX(bounds: WorldBounds): number {
  return bounds.x + bounds.width / 2;
}

function centerY(bounds: WorldBounds): number {
  return bounds.y + bounds.height / 2;
}
