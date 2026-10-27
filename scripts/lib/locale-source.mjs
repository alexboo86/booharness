import fs from 'node:fs';
import path from 'node:path';

/**
 * Source text of one language: src/locales/<lang>.ts plus that language's object
 * of every sibling locale module (`export const <name>En` / `<name>Ru`). Text
 * contracts that once read en.ts/ru.ts alone keep working after keys move into
 * modules (task 2830).
 */
export function localeSource(root, lang) {
  const dir = path.join(root, 'src/locales');
  const parts = [fs.readFileSync(path.join(dir, `${lang}.ts`), 'utf8')];
  const suffix = lang === 'en' ? 'En' : 'Ru';
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.ts') || file.includes('.test.') || ['en.ts', 'ru.ts', 'index.ts'].includes(file)) continue;
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const starts = [...text.matchAll(/^export const \w+(En|Ru)\b/gm)];
    starts.forEach((m, i) => {
      if (m[1] === suffix) parts.push(text.slice(m.index, starts[i + 1]?.index ?? text.length));
    });
  }
  return parts.join('\n');
}
