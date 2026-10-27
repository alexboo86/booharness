import { familyLabel } from './family-format';

export function leadFamily(family: string) {
  return familyLabel(family, family === 'codex' ? 'Codex' : family === 'claude' ? 'Claude' : family);
}

/** The fields shared by lead and seat badges; no daemon/runtime imports. */
export type BadgeSource = {
  kinds?: Record<string, number> | null;
  skills?: {
    required: string[];
    listed: string[];
    router: {
      skills: string;
      lessons: string;
      skillReason?: string;
      lessonReason?: string;
    } | null;
  } | null;
  extensions?: string[];
  lessons?: { full: number; indexed: number } | null;
};

export type Badge = {
  name: string;
  counts: (number | string)[];
  tone: 'used' | 'unused' | 'missing' | 'other' | 'mcp';
  detail: string;
};

export type BadgeGroup = {
  label: 'skills' | 'tools' | 'mcp' | 'pi';
  badges: Badge[];
};

const MCP_INSTRUMENTS = ['codegraph', 'memoryctl'];
const EXTENSION_TOOLS: Record<string, readonly string[]> = {
  'hashline-edit': ['tool:replace', 'tool:insert', 'tool:undo_last_change', 'tool:replace_within', 'tool:copy', 'tool:move', 'tool:anchor_grep'],
  'codex-edit': ['edit'],
};

export function tokenCount(tokens: number): string {
  return tokens >= 1e6 ? (tokens / 1e6).toFixed(2) + 'M'
    : tokens >= 1000 ? Math.round(tokens / 1000) + 'k' : String(tokens);
}

export function leadAge(iso: string, now = Date.now()): string {
  if (!iso) return '';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  const duration = seconds < 60 ? seconds + 's'
    : seconds < 3600 ? Math.floor(seconds / 60) + 'm ' + String(seconds % 60).padStart(2, '0') + 's'
      : Math.floor(seconds / 3600) + 'h ' + String(Math.floor(seconds % 3600 / 60)).padStart(2, '0') + 'm';
  return duration + ' ago';
}

export function leadTone(percent: number | null): 'subtle' | 'success' | 'warning' | 'permission' | 'error' {
  return percent == null ? 'subtle' : percent >= 100 ? 'error'
    : percent >= 85 ? 'permission' : percent >= 70 ? 'warning' : 'success';
}


/** Keep group order, counts and descriptions aligned with dashboard.ts badges(). */
export function badgeGroups(source: BadgeSource, instruments: readonly string[]): BadgeGroup[] {
  const kinds = source.kinds || {};
  const extensions = source.extensions || [];
  const owned = new Set(extensions.flatMap((name) => EXTENSION_TOOLS[name] || []));
  const groups: BadgeGroup[] = [];
  const skills: Badge[] = [];
  if (source.skills) {
    const router = source.skills.router;
    if (router && (router.skills === 'map' || router.lessons === 'unavailable')) {
      skills.push({
        name: 'no jev', counts: [], tone: 'missing',
        detail: [
          router.skills === 'map' && 'skills: map (' + (router.skillReason ?? 'unknown') + ')',
          router.lessons === 'unavailable' && 'lessons: unavailable (' + (router.lessonReason ?? 'unknown') + ')',
        ].filter(Boolean).join('; ') + ': routing fallback',
      });
    }
    for (const name of source.skills.required) {
      skills.push({ name, counts: [], tone: 'used', detail: 'skill inlined in the brief' });
    }
    for (const name of source.skills.listed) {
      const n = kinds['skill:' + name] || 0;
      skills.push({ name, counts: [], tone: n ? 'used' : 'unused', detail: n ? 'SKILL.md read' : 'routed to this seat, not read' });
    }
  }
  if (kinds.knowledge) {
    skills.push({ name: 'knowledge', counts: [kinds.knowledge], tone: 'used', detail: 'domain knowledge.md read' });
  }
  if (source.lessons) {
    const { full, indexed } = source.lessons;
    skills.push({
      name: 'lessons', counts: full + indexed === 0 ? [0] : [full + ' full', ...(indexed > 0 ? [indexed + ' on demand'] : [])],
      tone: full + indexed > 0 ? 'used' : 'unused',
      detail: 'full = whole text in the brief; on demand = title line, the seat reads it if needed',
    });
  }
  if (skills.length) groups.push({ label: 'skills', badges: skills });

  const tools: Badge[] = [];
  const missed = kinds['rtk-missed'] || 0;
  const pending = kinds['rtk-pending'] || 0;
  for (const name of instruments.filter((name) => !MCP_INSTRUMENTS.includes(name))) {
    const n = kinds[name] || 0;
    const waiting = name === 'rtk' && pending;
    const bad = name === 'rtk' && missed;
    if (!n && !waiting && !bad) continue;
    const counts: Badge['counts'] = [];
    if (n) counts.push(n);
    if (bad) counts.push(missed + ' missed');
    if (waiting) counts.push(pending + ' pending');
    tools.push({
      name, counts, tone: bad ? 'missing' : n ? 'used' : 'other',
      detail: bad ? missed + ' shell calls rtk has a filter for ran without it'
        : waiting ? pending + ' shell calls still waiting for an rtk verdict' : n + ' calls',
    });
  }
  const rest = Object.entries(kinds).filter(([key]) =>
    !instruments.includes(key) && !owned.has(key) && key !== 'shell'
    && key !== 'rtk-missed' && key !== 'rtk-pending' && key !== 'knowledge' && !key.startsWith('skill:'),
  ).sort((a, b) => b[1] - a[1]);
  for (const [key, n] of rest.filter(([key]) => !key.startsWith('mcp:') && !key.startsWith('sh:'))) {
    tools.push({
      name: key.replace(/^tool:/, ''), counts: [n], tone: 'other',
      detail: key.startsWith('tool:') ? 'provider tool' : 'built-in tool',
    });
  }
  const programs = rest.filter(([key]) => key.startsWith('sh:'));
  if (programs.length) {
    tools.push({
      name: 'shell', counts: [programs.reduce((sum, [, n]) => sum + n, 0)], tone: 'other',
      detail: 'shell programs, not through our instruments: ' + programs.map(([key, n]) => key.slice(3) + ' ' + n).join(', '),
    });
  }
  if (tools.length) groups.push({ label: 'tools', badges: tools });

  const mcp: Badge[] = [];
  for (const name of MCP_INSTRUMENTS) {
    const n = kinds[name] || 0;
    if (n) mcp.push({ name, counts: [n], tone: 'mcp', detail: n + ' calls (MCP tool or CLI)' });
  }
  for (const [key, n] of rest.filter(([key]) => key.startsWith('mcp:'))) {
    mcp.push({ name: key.slice(4), counts: [n], tone: 'mcp', detail: 'MCP server ' + key.slice(4) });
  }
  if (mcp.length) groups.push({ label: 'mcp', badges: mcp });

  const pi: Badge[] = [];
  for (const name of extensions) {
    const mine = EXTENSION_TOOLS[name];
    const n = mine ? mine.reduce((sum, key) => sum + (kinds[key] || 0), 0) : 0;
    pi.push({
      name, counts: n ? [n] : [], tone: !mine ? 'other' : n ? 'used' : 'unused',
      detail: !mine ? 'Pi extension loaded for this seat'
        : n ? n + ' calls of its tools' : 'Pi extension loaded, its tools not called yet',
    });
  }
  if (pi.length) groups.push({ label: 'pi', badges: pi });
  return groups;
}
