/** Shared BooHarness chrome. No data reads or import-time effects. */
export const PULT_STYLES = `
:root {
  color-scheme: light;
  /* Solo Ledger (operator 22285): cream canvas, ink 2px outlines, teal strip, ledger green, ochre, clay. Light only: the operator removed the dark theme 2026-10-30. */
  --bg: #FBF8F3;
  --surface: #FFFDF9;
  --raised: #FFFDF9;
  --ink: #0A0A0A;
  --ink-2: color-mix(in srgb, var(--ink) 70%, transparent);
  --muted: color-mix(in srgb, var(--ink) 55%, transparent);
  --faint: color-mix(in srgb, var(--ink) 30%, transparent);
  --line: color-mix(in srgb, var(--ink) 15%, transparent);
  --track: color-mix(in srgb, var(--ink) 8%, transparent);
  --outline: color-mix(in srgb, var(--ink) 72%, transparent);
  --neutral-fill: var(--track);
  --teal: #1F4A4E; --on-teal: #F5EFE6;
  --teal-ink: #1F4A4E;
  --green: #2A7A4A; --green-ink: #2A7A4A;
  --ochre: #B8862B; --ochre-ink: #8A6818;
  --peach: #F2D9CE;
  --mark: #F2D9CE; --on-mark: #0A0A0A;
  --tint-mint: #EEF6F1;
  --tint-sand: #F5EEE2;
  --tint-slate: #E9F0F0;
  --tint-clay: #F4E0D7;
  --band: var(--tint-slate); --on-band: var(--ink);
  /* Lightened composition (operator 2026-10-30 «осветлим»): the status strip and footer sit on tints, ink text. */
  --strip: var(--tint-slate); --on-strip: var(--ink);
  --accent: var(--teal-ink);
  --accent-soft: var(--tint-slate);
  --badge-ink: var(--ink-2); --badge-muted: var(--muted);
  --good: var(--green-ink);
  --warning: var(--ochre-ink);
  --serious: #B5541E;
  --critical: #A8322A;
  --critical-soft: #F3D9D2;
  --warning-soft: color-mix(in srgb, var(--ochre) 20%, var(--bg));
  --on-critical: #F5EFE6;
  --cell-shadow: inset 0 2px 0 rgb(255 255 255 / .5), inset 0 -2px 8px rgb(10 10 10 / .06);
  --shadow: var(--cell-shadow);
  --font-display: "Space Grotesk", ui-sans-serif, system-ui, sans-serif;
  --font-body: Inter, ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, Menlo, monospace;
  --stroke: .1rem;
  --badge-line-height: 1.25rem; --badge-border-width: .125rem; --skills-label-width: 3.5rem;
  --pult-radius: .75rem; --pult-gap: 1rem;
}
/* The Ledger scale (operator 2026-10-30): every rem on the page is 85% of the browser default. */
html { font-size: 85%; }
[hidden] { display: none !important; }
body { background: var(--bg); color: var(--ink); font: .8125rem/1.5 var(--font-body); }
.pult-label { font: 600 .6875rem/1.4 var(--font-display); letter-spacing: .12em; text-transform: uppercase; }
.pult-top { display: flex; align-items: stretch; flex-wrap: wrap; gap: 0 1rem; padding: 0 2rem; background: var(--bg); border-bottom: var(--stroke) solid var(--outline); }
.pult-top > .dot { align-self: center; display: inline-flex; align-items: center; justify-content: center; width: 2rem; height: 2rem; border: var(--stroke) solid var(--outline); border-radius: .5rem; background: var(--teal); }
.pult-top > .dot::after { content: ""; width: .75rem; height: .75rem; border-radius: .125rem; background: var(--mark); }
.pult-top > .dot.off::after { background: var(--critical); }
.pult-top .brand { align-self: center; padding: 1.25rem 0; font: 700 1.25rem/1 var(--font-display); letter-spacing: -.025em; text-transform: uppercase; }
.pult-top .brand::after { content: "."; color: var(--teal-ink); }
.pult-nav { display: flex; align-items: stretch; margin: 0 auto 0 1.5rem; }
.pult-nav a, .pult-nav button { position: relative; display: inline-flex; align-items: center; justify-content: center; padding: 0 1.5rem; border: 0; border-right: var(--stroke) solid var(--outline); border-radius: 0; background: transparent; color: var(--muted); cursor: pointer; text-decoration: none; font: 600 .875rem/1 var(--font-display); letter-spacing: -.01em; }
.pult-nav > :first-child { border-left: var(--stroke) solid var(--outline); }
.pult-nav [aria-current="page"], .pult-nav a:hover, .pult-nav button:hover { background: var(--peach); color: var(--ink); }
.pult-nav svg { display: none; }
.pult-sr { position: absolute; width: .0625rem; height: .0625rem; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.pult-nav .pult-sr { position: static; width: auto; height: auto; overflow: visible; clip-path: none; }
:is(a, button, summary, input, textarea):focus-visible { outline: var(--stroke) solid var(--teal-ink); outline-offset: .2rem; }
::selection { background: var(--peach); color: var(--ink); }
input, textarea { caret-color: var(--ink); }
* { scrollbar-color: var(--muted) var(--surface); }
.pult-footer { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1.5rem; padding: .75rem 2rem; border-top: var(--stroke) solid var(--outline); background: var(--band); color: color-mix(in srgb, var(--on-band) 60%, transparent); font: 600 .6875rem/1.4 var(--font-display); letter-spacing: .12em; text-transform: uppercase; }
.pult-footer > :first-child { margin-right: auto; }
@media (pointer: coarse) { .pult-nav a, .pult-nav button { min-width: 2.75rem; min-height: 2.75rem; } }
@media (max-width: 45rem) { .pult-top { padding: 0 1rem; } .pult-nav { margin-left: 0; } .pult-nav a, .pult-nav button { padding: 0 .75rem; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;

/** Ledger fonts (operator 22285): Space Grotesk headings, Inter body, JetBrains Mono figures; system fonts when offline. */
export const PULT_FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600;700&display=swap">`;

const icons = {
  Board: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  Tasks: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>',
  Limits: '<path d="M4 18a9 9 0 1 1 16 0M12 12l5-5M5 18h14"/>',
  Machines: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8M12 16v5"/>',
  Chat: '<path d="M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 1 1 17-5Z"/>',
};

/** Static trusted markup only; labels and paths are not caller-controlled. */
export function pultHeader(active: 'Board' | 'Tasks'): string {
  const nav = (Object.keys(icons) as (keyof typeof icons)[]).map((name) => {
    const content = '<svg viewBox="0 0 24 24" aria-hidden="true">' + icons[name] + '</svg><span class="pult-sr">' + name + '</span>';
    const attrs = ' aria-label="' + name + '" data-tooltip="' + name + '"' + (name === active ? ' aria-current="page"' : '');
    if (name === 'Board' || name === 'Tasks') return '<a href="' + (name === 'Board' ? '/' : '/tasks') + '"' + attrs + '>' + content + '</a>';
    const view = name.toLowerCase();
    return active === 'Tasks'
      ? '<a href="/#' + view + '"' + attrs + '>' + content + '</a>'
      : '<button type="button" data-board-view="' + view + '"' + attrs + '>' + content + '</button>';
  }).join('');
  return '<div class="pult-top"><span class="dot" id="dot"></span><span class="brand">orch</span><nav class="pult-nav" aria-label="Main">' + nav + '</nav></div>';
}

