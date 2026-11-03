import type { TextAnchor, TextFormatMark } from '../protocols/formatting.ts';

export interface TextFormattingEdit {
  start: number;
  deleteCount: number;
  insertLength: number;
}

/** The same biased ranges drive durable edits and the editable projection. */
export function transformTextFormatMarks(marks: TextFormatMark[], edit: TextFormattingEdit): TextFormatMark[] {
  return marks.flatMap((mark) => {
    const start = transformAnchor(mark.start, edit);
    const end = transformAnchor(mark.end, edit);
    if (start.offset >= end.offset) return [];
    if (start.offset === mark.start.offset && end.offset === mark.end.offset) return [mark];
    return [{ ...mark, start, end, revision: mark.revision + 1 }];
  });
}

function transformAnchor(anchor: TextAnchor, edit: TextFormattingEdit): TextAnchor {
  const end = edit.start + edit.deleteCount;
  if (edit.deleteCount === 0) {
    if (anchor.offset < edit.start || (anchor.offset === edit.start && anchor.bias === 'before')) return anchor;
    return { ...anchor, offset: anchor.offset + edit.insertLength };
  }
  if (anchor.offset < edit.start) return anchor;
  if (anchor.offset > end) return { ...anchor, offset: anchor.offset - edit.deleteCount + edit.insertLength };
  return { ...anchor, offset: anchor.bias === 'after' ? edit.start + edit.insertLength : edit.start };
}
