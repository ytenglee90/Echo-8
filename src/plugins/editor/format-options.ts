/** Shared format stepping order for the toolbar and keyboard operations. */
export const FORMAT_STEP_OPTIONS = {
  fontSize: [12, 13, 14, 15, 16, 18, 20, 24, 28, 32],
  fontWeight: [300, 400, 500, 600, 700, 800, 900],
  lineHeight: [1.2, 1.4, 1.5, 1.7, 1.9, 2.2, 2.6],
  letterSpacing: [-0.5, 0, 0.5, 1, 1.5, 2, 3],
  firstLineIndent: [0, 1, 1.5, 2, 2.5, 3, 4],
  paragraphSpacing: [0, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2],
} as const;
