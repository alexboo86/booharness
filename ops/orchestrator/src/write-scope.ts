import path from 'node:path';
import os from 'node:os';
import { lstatSync, realpathSync } from 'node:fs';
import { braceExpand, Minimatch } from 'minimatch';

export type ExtraWriteScope = { globs: string[]; reason: string };

function relativeGlob(slashed: string): boolean {
  return !path.posix.isAbsolute(slashed) && !path.win32.parse(slashed).root
    && !slashed.startsWith('~') && !slashed.split('/').includes('..');
}

function includesGitMetadata(pattern: string): boolean {
  try {
    // dot:true prevents blanket grants hiding behind dot-path exclusions.
    // braceExpandMax truncates rather than throws: read one beyond the budget
    // and reject, so an unseen wildcard alternative can never be authorized.
    if (braceExpand(pattern, { braceExpandMax: 201 }).length > 200) throw new Error('too many alternatives');
    const matcher = new Minimatch(pattern, { dot: true, nonegate: true, nocomment: true, braceExpandMax: 201 });
    return matcher.globSet.some((expanded) => !relativeGlob(expanded) || gitSegment(expanded))
      || matcher.match('.git') || matcher.match('.git/config');
  } catch {
    throw new Error('writeScope glob cannot be parsed within the 200-pattern expansion limit');
  }
}

function gitSegment(pattern: string): boolean {
  return pattern.split('/').some((part) => path.posix.matchesGlob('.git', part.toLowerCase()));
}

/** Lead-declared additions are bounded repo paths, never an unrestricted grant. */
function scopeGlob(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || raw.length > 512 || /[\0\r\n]/.test(raw)) throw new Error('writeScope globs must be non-empty paths of at most 512 characters');
  const slashed = raw.replaceAll('\\', '/');
  if (!relativeGlob(slashed)) throw new Error('writeScope globs must be repo-relative without ..');
  const normalized = path.posix.normalize(slashed).replace(/\/$/, '');
  if (normalized.startsWith('!')) throw new Error('writeScope globs must not be negated');
  if (normalized === '.' || normalized.split('/').every((part) => /^[*?]+$/.test(part))) throw new Error('writeScope globs must not match everything');
  if (includesGitMetadata(normalized)) throw new Error('writeScope globs must not include .git, absolute or parent paths (including brace alternatives)');
  return normalized;
}

function scopeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('writeScope must contain globs and reason');
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some((key) => key !== 'globs' && key !== 'reason')) throw new Error('writeScope takes only globs and reason');
  return obj;
}

function scopeGlobs(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 200) throw new Error('writeScope globs must contain 1..200 paths');
  return [...new Set(value.map(scopeGlob))];
}

function scopeReason(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 300) throw new Error('writeScope reason must be 1..300 characters');
  return value.trim();
}

export function extraWriteScope(value: unknown, restricted: boolean): ExtraWriteScope | undefined {
  if (value === undefined) return undefined;
  if (!restricted) throw new Error('writeScope is only for roles with a restricted write scope');
  const obj = scopeObject(value);
  return { globs: scopeGlobs(obj.globs), reason: scopeReason(obj.reason) };
}

/** A repo-relative path is inside a write-scope list. Absolute paths and .. are outside. */
export function pathInWriteScope(file: string, scope: readonly string[]): boolean {
  if (!file || file.includes('\0')) return false;
  const slashed = file.replaceAll('\\', '/');
  if (path.posix.isAbsolute(slashed) || path.win32.isAbsolute(file) || slashed.split('/').includes('..')) return false;
  const safe = path.posix.normalize(slashed);
  if (!safe || safe === '.' || safe.startsWith('../') || path.posix.isAbsolute(safe)) return false;
  return scope.some((pattern) => path.posix.matchesGlob(safe, pattern));
}

function patchFileTargets(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: ([^\r\n]+)/gm)) found.push(match[1].trim());
  for (const match of text.matchAll(/^\*\*\* Move to: ([^\r\n]+)/gm)) found.push(match[1].trim());
  for (const match of text.matchAll(/^diff --git a\/(\S+) b\/(\S+)/gm)) {
    if (match[1] !== '/dev/null') found.push(match[1]);
    if (match[2] !== '/dev/null') found.push(match[2]);
  }
  return found.map((file) => file.replace(/^['"]|['"]$/g, ''));
}

const MUTATING_PATH_KEYS = ['path', 'file_path', 'filePath', 'notebook_path', 'from', 'to', 'source', 'destination', 'src', 'dest', 'old_path', 'new_path'];

/** File tool destinations, including both sides of moves and patch headers. */
export function mutatingTargets(toolName: string, input: unknown): string[] {
  const obj = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const direct = MUTATING_PATH_KEYS.flatMap((key) => typeof obj[key] === 'string' ? [obj[key] as string] : []);
  if (toolName !== 'apply_patch') return direct;
  const blobs = [obj.patch, obj.input, obj.diff, typeof input === 'string' ? input : undefined];
  return [...direct, ...blobs.filter((value): value is string => typeof value === 'string').flatMap(patchFileTargets)];
}

export function readWriteScope(raw: string | undefined): readonly string[] | undefined | 'unreadable' {
  if (raw === undefined || raw === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) return 'unreadable';
    return parsed;
  } catch {
    return 'unreadable';
  }
}

function scopeRelative(raw: string, cwd: string): string | null {
  if (!raw || raw.startsWith('~') || raw.includes('\0')) return null;
  const rel = path.relative(cwd, path.resolve(cwd, raw));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** Resolve missing leaves through their nearest existing parent, never through a dangling link. */
function realPathForWrite(file: string): string {
  try {
    return realpathSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(realPathForWrite(parent), path.basename(file));
  }
}

function insideDirectory(file: string, directory: string): boolean {
  const rel = path.relative(directory, file);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function mutationRealPath(raw: string, cwd: string): string {
  // Pi editors expand these spellings differently. Require literal native paths
  // rather than authorize a lexical alias that may name a different destination.
  if (!raw || /^[~@]/.test(raw) || raw.startsWith('file:') || /[\0\u00a0\u2000-\u200a\u202f\u205f\u3000]/.test(raw)) {
    throw new Error('non-literal mutation path');
  }
  if (process.platform === 'win32' && /^\/(?!\/)/.test(raw)) throw new Error('non-native Windows path');
  return realPathForWrite(path.resolve(cwd, raw));
}

function worktreeWriteBlock(toolName: string, targets: readonly string[], worktree: string): { block: true; reason: string } | undefined {
  try {
    const roots = [realpathSync(worktree), realpathSync(os.tmpdir())];
    if (targets.length && targets.every((raw) => {
      const target = mutationRealPath(raw, worktree);
      return roots.some((root) => insideDirectory(target, root));
    })) return undefined;
  } catch {
    // Unknown, inaccessible and dangling destinations fail closed.
  }
  return { block: true, reason: `worktree write guard blocks ${toolName}: target outside the worktree or unresolved (${targets.join(', ')}). Your worktree is ${worktree}; write there. Only the OS temp directory (including seat temp files) is also allowed.` };
}

/** Caller selects mutating tools; undefined scope applies containment only.
 * Bash is deliberately not a file-tool sandbox. */
export function writeScopeBlock(toolName: string, input: unknown, scope: readonly string[] | 'unreadable' | undefined, cwd = process.cwd()): { block: true; reason: string } | undefined {
  if (scope === 'unreadable') return { block: true, reason: 'write scope is set but unreadable; no mutating tool may run until the seat is restarted with a scope list.' };
  const targets = mutatingTargets(toolName, input);
  if (!targets.length && scope !== undefined) return { block: true, reason: `write scope blocks ${toolName}: the call names no target path. Scope: ${scope.join(', ')}.` };
  const containment = worktreeWriteBlock(toolName, targets, cwd);
  if (containment || scope === undefined) return containment;
  const named = scope.join(', ');
  const outside = targets.filter((file) => {
    const rel = scopeRelative(file, cwd);
    return rel === null || !pathInWriteScope(rel, scope);
  });
  if (!outside.length) return undefined;
  return { block: true, reason: `write scope blocks ${toolName} outside the seat scope (${named}): ${outside.join(', ')}` };
}
