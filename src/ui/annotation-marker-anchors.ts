import type { AnnotationMarkerAnchorsPreview } from '../protocols/annotations.ts';

type MarkerAnchor = NonNullable<AnnotationMarkerAnchorsPreview['anchors']>[number];

/** Collects visible marker geometry without exposing either feature view's DOM. */
export function collectAnnotationMarkerAnchors(root: HTMLDivElement | null): MarkerAnchor[] {
  return [...(root?.querySelectorAll<HTMLElement>('[data-annotation-id]') ?? [])]
    .map((marker) => ({ id: marker.dataset.annotationId ?? '', rect: marker.getBoundingClientRect() }))
    .filter((anchor) => anchor.id && anchor.rect.width > 0 && anchor.rect.height > 0)
    .map((anchor) => ({
      id: anchor.id,
      rect: {
        x: anchor.rect.x,
        y: anchor.rect.y,
        width: anchor.rect.width,
        height: anchor.rect.height,
      },
    }));
}
