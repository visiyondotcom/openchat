// Ollama's /api/chat has no real "continue from where you left off" mode
// (confirmed dead end: ollama/ollama#6778 is still an open feature request).
// The best we can do is prompt it to continue and not repeat itself (see
// the continue-instruction system message in routes/chats.ts), but models
// still frequently re-emit the tail of the previous message — sometimes
// the last sentence, sometimes the whole thing verbatim — before actually
// continuing. This is a safety net that strips that overlap back out
// before the "continue" result is shown or persisted.

export interface MergeResult {
  // Text to actually append to the existing message (may be shorter than
  // `addition` if a duplicated prefix was stripped, or empty if the whole
  // thing was a duplicate).
  text: string;
  // True if `addition` (after stripping leading/trailing whitespace) was
  // entirely a repeat of the end of `existing` and nothing new was added.
  droppedAsDuplicate: boolean;
  // How many characters were stripped off the front of `addition` because
  // they duplicated the tail of `existing`. 0 when no overlap was found.
  overlapChars: number;
}

// Longest suffix of `existing` that is also a prefix of `addition`,
// compared case-insensitively and whitespace-normalized so trivial
// differences (a trailing space, a capitalized restart) still count as
// a match. Capped at a generous window so this stays cheap on long
// messages — repeats happen at the seam, not paragraphs back.
const MAX_OVERLAP_WINDOW = 600;

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export function mergeContinuation(existing: string, addition: string): MergeResult {
  const addTrimmed = addition.trim();
  if (!addTrimmed) {
    return { text: "", droppedAsDuplicate: false, overlapChars: 0 };
  }

  const tail = existing.slice(-MAX_OVERLAP_WINDOW);
  const normTail = normalize(tail);
  const normAdd = normalize(addTrimmed);

  if (!normTail || !normAdd) {
    return { text: addition, droppedAsDuplicate: false, overlapChars: 0 };
  }

  // If the whole new chunk already appears at the very end of what we
  // have (model just re-said the ending, or the whole answer again),
  // drop it entirely rather than appending a near-duplicate.
  if (normTail.endsWith(normAdd) || normAdd.length <= normTail.length && normTail.includes(normAdd)) {
    // Only treat as a full duplicate when it's anchored at/near the seam,
    // not any coincidental substring match deep in earlier text — the
    // tail window is already short enough that this is safe.
    return { text: "", droppedAsDuplicate: true, overlapChars: addTrimmed.length };
  }

  // Otherwise, find the longest prefix of the new text that matches a
  // suffix of the existing text, and strip just that overlapping part.
  const maxCheck = Math.min(normTail.length, normAdd.length);
  let overlapLen = 0;
  for (let len = maxCheck; len > 0; len--) {
    if (normTail.slice(-len) === normAdd.slice(0, len)) {
      overlapLen = len;
      break;
    }
  }

  // Ignore tiny (< 8 char) overlaps — too likely to be a coincidental
  // word match ("de", "het is") rather than an actual repeat.
  if (overlapLen < 8) {
    return { text: addition, droppedAsDuplicate: false, overlapChars: 0 };
  }

  // Map the normalized overlap length back onto the raw (un-normalized)
  // addition by walking it the same way normalize() does, so we cut at
  // the right character offset even though whitespace was collapsed.
  let rawIdx = 0;
  let normCount = 0;
  let prevWasSpace = false;
  for (; rawIdx < addTrimmed.length && normCount < overlapLen; rawIdx++) {
    const ch = addTrimmed[rawIdx];
    if (/\s/.test(ch)) {
      if (!prevWasSpace) normCount++;
      prevWasSpace = true;
    } else {
      normCount++;
      prevWasSpace = false;
    }
  }

  const stripped = addTrimmed.slice(rawIdx).replace(/^\s+/, "");
  return { text: stripped, droppedAsDuplicate: stripped.length === 0, overlapChars: rawIdx };
}
