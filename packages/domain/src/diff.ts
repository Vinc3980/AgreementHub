/**
 * Word-level diff for version comparison highlights (added / removed /
 * unchanged runs). Pure and deterministic, used by the API diff payload
 * consumers (web) so both sides highlight the same way.
 *
 * Strategy: tokenize (whitespace runs stay tokens so the original text can be
 * rebuilt byte-for-byte), trim the common prefix/suffix first, then run an LCS
 * over the remainder. The DP is capped so pathological inputs degrade to a
 * whole-block replace instead of blowing up memory.
 */

export interface DiffToken {
  text: string;
  op: 'same' | 'added' | 'removed';
}

export interface WordDiff {
  /** Tokens that rebuild `before` exactly (whitespace preserved). */
  before: DiffToken[];
  /** Tokens that rebuild `after` exactly (whitespace preserved). */
  after: DiffToken[];
}

/** Max DP cells (≈630×630) before falling back to a block replace. */
const MAX_DP_CELLS = 400_000;

function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

export function diffWords(before: string, after: string): WordDiff {
  if (before === after) {
    const tokens = tokenize(before).map((text) => ({ text, op: 'same' as const }));
    return { before: tokens, after: tokens };
  }

  const a = tokenize(before);
  const b = tokenize(after);

  // Common prefix / suffix (cheap win for localized edits).
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const head: DiffToken[] = a.slice(0, start).map((text) => ({ text, op: 'same' as const }));
  const tail: DiffToken[] = a.slice(endA).map((text) => ({ text, op: 'same' as const }));
  const tailB: DiffToken[] = b.slice(endB).map((text) => ({ text, op: 'same' as const }));

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  let midBefore: DiffToken[];
  let midAfter: DiffToken[];
  if (midA.length * midB.length > MAX_DP_CELLS) {
    // Too large for LCS, report the whole middle as replaced.
    midBefore = midA.map((text) => ({ text, op: 'removed' as const }));
    midAfter = midB.map((text) => ({ text, op: 'added' as const }));
  } else {
    ({ before: midBefore, after: midAfter } = lcsMid(midA, midB));
  }

  return {
    before: [...head, ...midBefore, ...tail],
    after: [...head, ...midAfter, ...tailB],
  };
}

function lcsMid(a: string[], b: string[]): { before: DiffToken[]; after: DiffToken[] } {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  // Flat DP: dp[i][j] = LCS length of a[i..] and b[j..].
  const dp = new Array<number>((n + 1) * width).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    const ai = a[i] ?? '';
    const rowBase = i * width;
    const nextBase = (i + 1) * width;
    for (let j = m - 1; j >= 0; j -= 1) {
      const bj = b[j] ?? '';
      dp[rowBase + j] =
        ai === bj
          ? (dp[nextBase + j + 1] ?? 0) + 1
          : Math.max(dp[nextBase + j] ?? 0, dp[rowBase + j + 1] ?? 0);
    }
  }

  const before: DiffToken[] = [];
  const after: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i] ?? '';
    const bj = b[j] ?? '';
    if (ai === bj) {
      before.push({ text: ai, op: 'same' });
      after.push({ text: bj, op: 'same' });
      i += 1;
      j += 1;
    } else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + j + 1] ?? 0)) {
      before.push({ text: ai, op: 'removed' });
      i += 1;
    } else {
      after.push({ text: bj, op: 'added' });
      j += 1;
    }
  }
  while (i < n) {
    before.push({ text: a[i] ?? '', op: 'removed' });
    i += 1;
  }
  while (j < m) {
    after.push({ text: b[j] ?? '', op: 'added' });
    j += 1;
  }
  return { before, after };
}

/** Rebuild the original string from tokens (round-trip safety for tests). */
export function joinTokens(tokens: DiffToken[]): string {
  return tokens.map((t) => t.text).join('');
}
