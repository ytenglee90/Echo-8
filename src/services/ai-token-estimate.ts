export function estimateAITokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  let compactRun = 0;
  const flushRun = () => {
    if (compactRun > 0) tokens += Math.ceil(compactRun / 4);
    compactRun = 0;
  };
  for (const character of text) {
    if (/\s/u.test(character)) {
      flushRun();
    } else if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u.test(character)) {
      flushRun();
      tokens += 1;
    } else if (/[\p{L}\p{N}_]/u.test(character)) {
      compactRun += character.length;
    } else {
      flushRun();
      tokens += 0.5;
    }
  }
  flushRun();
  return Math.max(1, Math.ceil(tokens));
}

