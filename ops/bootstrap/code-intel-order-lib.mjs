// The session-order rule of code-intel-order-hook.mjs, shared with its sibling
// domain-lessons-hook.mjs: a context the order hook refuses never reaches the
// model, so the sibling must not spend a once-per-session delivery on it.
// Kept free of imports beyond node: both hooks run on every lead Read.

import { join } from 'node:path';
import { tmpdir } from 'node:os';

/// The once-per-session mark a code search writes, or '' when the event names
/// no session. A native read of a source file is refused until it exists.
export function codeIntelMark(sessionId) {
  const session = String(sessionId ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  return session ? join(tmpdir(), 'toolset-code-intel', session) : '';
}

/// Which search answers questions about a file. Both languages open with
/// codegraph; Rust additionally has a shape question no graph answers, and the
/// refusal names it, because a seat told only "use codegraph" reaches for
/// codegraph and never learns the other half exists.
export function indexFor(target) {
  const lowered = String(target || '').toLowerCase();
  if (lowered.endsWith('.ts') || lowered.endsWith('.tsx')) {
    return 'codegraph explore (mcp__codegraph__codegraph_explore), written in English';
  }
  if (lowered.endsWith('.rs')) {
    return (
      'codegraph explore (mcp__codegraph__codegraph_explore), written in English - and ast-grep ' +
      'when the question is a SHAPE (every trait impl, every call of X), which ' +
      // No `{ $$$ }`: the brace must sit on the same line, so both patterns then
      // miss an impl whose `where` clause pushes it down — measured 2026-09-18
      // over a Rust source tree, 4 files with the braces against 5 without (4c96ed413).
      'needs BOTH `impl $T for $S` and `impl<$G> $T for $S`'
    );
  }
  return null;
}
