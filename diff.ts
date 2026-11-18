/**
 * Minimal line diff used to write a human-readable report next to a conflict copy.
 *
 * This is deliberately not a merge: it never rewrites either side, it only explains
 * what differs. Input is two decoded texts, output is a unified diff in the same
 * shape `diff -u` / `git diff` produce, so it can be pasted into any diff viewer.
 *
 * The search is an LCS table, which is exact but O(n*m). The caller-facing entry
 * point trims the common prefix/suffix first (most edits are local) and refuses
 * inputs that are still too large, because a diff nobody can read is not worth
 * blocking the vault for.
 */

export type DiffOp = { op: " " | "-" | "+"; line: string };

/** Cells in the LCS table; 4M ≈ 16 MB of Int32 and a few tens of ms. */
const MAX_CELLS = 4_000_000;

/** Strip CR so a CRLF copy does not diff as "every line changed". */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

function lcsOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const row = i * w;
    const next = row + w;
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] = a[i] === b[j]
        ? dp[next + j + 1] + 1
        : Math.max(dp[next + j], dp[row + j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: " ", line: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ op: "-", line: a[i] });
      i++;
    } else {
      ops.push({ op: "+", line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ op: "-", line: a[i++] });
  while (j < m) ops.push({ op: "+", line: b[j++] });
  return ops;
}

function hunkify(ops: DiffOp[], aLabel: string, bLabel: string, context: number): string[] {
  const out: string[] = [`--- ${aLabel}`, `+++ ${bLabel}`];
  const oldBefore = new Int32Array(ops.length + 1);
  const newBefore = new Int32Array(ops.length + 1);
  for (let i = 0; i < ops.length; i++) {
    oldBefore[i + 1] = oldBefore[i] + (ops[i].op === "+" ? 0 : 1);
    newBefore[i + 1] = newBefore[i] + (ops[i].op === "-" ? 0 : 1);
  }
  const hunks: Array<[number, number]> = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].op === " ") continue;
    const start = Math.max(0, i - context);
    const end = Math.min(ops.length, i + context + 1);
    const last = hunks[hunks.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else hunks.push([start, end]);
  }
  for (const [s, e] of hunks) {
    const aCount = oldBefore[e] - oldBefore[s];
    const bCount = newBefore[e] - newBefore[s];
    const aStart = aCount === 0 ? oldBefore[s] : oldBefore[s] + 1;
    const bStart = bCount === 0 ? newBefore[s] : newBefore[s] + 1;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (let i = s; i < e; i++) out.push(ops[i].op + ops[i].line);
  }
  return out;
}

/**
 * Unified diff between two texts.
 * Returns null when the inputs are too large to diff cheaply.
 * Returns an empty string when the texts have no line-level difference
 * (e.g. they differ only in line endings or a trailing newline).
 */
export function unifiedDiff(aText: string, bText: string, aLabel: string, bLabel: string, context = 3): string | null {
  const a = splitLines(aText);
  const b = splitLines(bText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length === 0 && midB.length === 0) return "";
  if ((midA.length + 1) * (midB.length + 1) > MAX_CELLS) return null;
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ op: " ", line: a[i] });
  ops.push(...lcsOps(midA, midB));
  for (let i = endA; i < a.length; i++) ops.push({ op: " ", line: a[i] });
  return hunkify(ops, aLabel, bLabel, context).join("\n");
}

/** True when the bytes look like text we can diff (no NUL, decodable UTF-8). */
export function looksLikeText(buf: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function decodeText(buf: ArrayBuffer): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(buf));
}
