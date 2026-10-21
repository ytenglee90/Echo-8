import type { AIGenerateStreamEvent } from '../../protocols/ai.ts';

type DeltaEvent = Extract<AIGenerateStreamEvent, { type: 'delta' }>;
type ReasoningTag = 'think' | 'analysis';

/** Separates provider text that embeds reasoning tags inside answer deltas. */
export class EmbeddedReasoningStream {
  private buffer = '';
  private reasoningTag: ReasoningTag | undefined;

  push(text: string): DeltaEvent[] {
    this.buffer += text;
    return this.drain(false);
  }

  flush(): DeltaEvent[] {
    return this.drain(true);
  }

  private drain(flush: boolean): DeltaEvent[] {
    const events: DeltaEvent[] = [];
    while (this.buffer) {
      if (!this.reasoningTag) {
        const opening = /<(think|analysis)>/iu.exec(this.buffer);
        if (opening) {
          this.emit(events, 'answer', this.buffer.slice(0, opening.index));
          this.reasoningTag = opening[1].toLocaleLowerCase() as ReasoningTag;
          this.buffer = this.buffer.slice(opening.index + opening[0].length);
          continue;
        }
        const keep = flush ? 0 : partialTagSuffix(this.buffer, ['<think>', '<analysis>']);
        this.emit(events, 'answer', this.buffer.slice(0, this.buffer.length - keep));
        this.buffer = keep > 0 ? this.buffer.slice(-keep) : '';
        break;
      }
      const closing = `</${this.reasoningTag}>`;
      const closingIndex = this.buffer.toLocaleLowerCase().indexOf(closing);
      if (closingIndex >= 0) {
        this.emit(events, 'reasoning', this.buffer.slice(0, closingIndex));
        this.buffer = this.buffer.slice(closingIndex + closing.length);
        this.reasoningTag = undefined;
        continue;
      }
      const keep = flush ? 0 : partialTagSuffix(this.buffer, [closing]);
      this.emit(events, 'reasoning', this.buffer.slice(0, this.buffer.length - keep));
      this.buffer = keep > 0 ? this.buffer.slice(-keep) : '';
      break;
    }
    return events;
  }

  private emit(events: DeltaEvent[], channel: 'answer' | 'reasoning', delta: string): void {
    if (delta) events.push({ type: 'delta', channel, delta });
  }
}

function partialTagSuffix(text: string, candidates: string[]): number {
  const lower = text.toLocaleLowerCase();
  const maximum = Math.min(lower.length, Math.max(...candidates.map((candidate) => candidate.length - 1)));
  for (let length = maximum; length > 0; length -= 1) {
    const suffix = lower.slice(-length);
    if (candidates.some((candidate) => candidate.startsWith(suffix))) return length;
  }
  return 0;
}
