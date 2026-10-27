import { createHash } from 'node:crypto';

/** Ignore the stamp itself and normalize checkout line endings. */
export function stampedBody(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^body-sha256:/.test(line))
    .join('\n')
    .trimEnd();
}

export function bodyDigest(text) {
  return createHash('sha256').update(stampedBody(text), 'utf8').digest('hex').slice(0, 12);
}
