// Shared replacement mechanics; callers that supply a file require complete,
// standalone marker pairs and preserve outside bytes. Other callers retain
// the installer's historical first-pair and append formatting policy.
export function replaceMarked(existing, begin, end, block, { file } = {}) {
  const text = existing ?? '';
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alternatives = `(${escape(begin)}|${escape(end)})`;
  const pattern = file
    ? new RegExp(`^[ \\t]*${alternatives}[ \\t]*(?=\\r?$)`, 'gm')
    : new RegExp(alternatives, 'g');
  const markers = Array.from(text.matchAll(pattern));
  if (!file) {
    const opening = markers.find((marker) => marker[1] === begin);
    const closing = markers.find((marker) => marker[1] === end);
    if (opening && closing && closing.index > opening.index) {
      return text.slice(0, opening.index) + block + text.slice(closing.index + closing[0].length);
    }
    return !text.trim() ? `${block}\n` : `${text.replace(/\s*$/, '')}\n\n${block}\n`;
  }
  const refuse = (marker, why = '') => {
    const line = text.slice(0, marker.index).split('\n').length;
    throw new Error(`${file}:${line}: unpaired marker ${marker[1]}${why}; configuration was not written`);
  };
  // An END with no BEGIN is this installer's own line and closes nothing: only that
  // line goes (the old first-pair replacement left such lines behind). A BEGIN with no
  // END refuses, because nothing says which of the lines after it are the operator's.
  const pairs = [];
  const strays = [];
  let opening;
  for (const marker of markers) {
    if (marker[1] === begin) {
      if (opening) refuse(opening);
      opening = marker;
    } else if (!opening) {
      strays.push(marker);
    } else {
      pairs.push([opening, marker]);
      opening = undefined;
    }
  }
  if (opening) refuse(opening);
  // A marker-only line can be the operator's text only inside a TOML multi-line string.
  // A file that holds such a string keeps its stray END: the line is not judged here.
  if (strays.length && /"""|'''/.test(text)) {
    refuse(strays[0], ' in a file with a multi-line string (the line can be its text)');
  }
  // A removed line owns its terminator, not a blank outside line.
  const afterLine = (cursor) => (text.startsWith('\r\n', cursor) ? cursor + 2 : text[cursor] === '\n' ? cursor + 1 : cursor);
  const cuts = [
    ...pairs.map(([first, last], index) => {
      const stop = last.index + last[0].length;
      return [first.index, index === 0 ? stop : afterLine(stop), index === 0 ? block : ''];
    }),
    ...strays.map((marker) => [marker.index, afterLine(marker.index + marker[0].length), '']),
  ].sort((a, b) => a[0] - b[0]);
  let kept = '';
  let cursor = 0;
  for (const [start, stop, replacement] of cuts) {
    kept += text.slice(cursor, start) + replacement;
    cursor = stop;
  }
  kept += text.slice(cursor);
  if (pairs.length) return kept;
  // An appended block ends its own line, so a later append cannot join the END marker.
  return `${kept}${kept && !kept.endsWith('\n') ? '\n' : ''}${block}\n`;
}
