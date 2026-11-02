import { defineSetting, type SettingDefinition } from '../registry.ts';
import { loadRoutines, ROUTINES_DIR } from '../../../../../scripts/lib/routines.mjs';

type RoutineRecord = { id: string; title: string; cron: string; summary: string };

// Today only the lead app's scheduler runs routines: a scheduled task is created
// solely by that app's scheduler tool and is edited or deleted only there
// (ops/routines/CONTRACT.md; .agents/skills/setup-routines/SKILL.md). Orch has
// no reader of the app's task list and no runner, so this category declares the
// shipped list read-only: one row per routine with what it does and how often,
// value = the cadence the definition ships. No on/off switch is declared — a
// switch here would change nothing. readOnly enforces that boundary for writes
// and resets. Required apply='restart' describes reloading shipped metadata on
// daemon restart, not applying a schedule to the app's scheduler.
export function routineSettings(dir: string = ROUTINES_DIR): SettingDefinition[] {
  return loadRoutines(dir).map((routine: RoutineRecord) => ({
    key: `routines.${routine.id}.schedule`, label: routine.title, category: 'routines', group: 'automation',
    tier: 'basic', control: 'text', class: 'user', scope: 'install', type: 'string',
    default: routine.cron, readOnly: true, apply: 'restart',
    help: `${routine.summary} Runs ${routine.cron} (local time); read-only, so the default keeps the shipped schedule description, not an active timer. The lead app's scheduler owns the run, not orch; change actual scheduled runs there.`,
    reads: `ops/routines/${routine.id}.md via scripts/lib/routines.mjs loadRoutines; the lead app's scheduler runs it (setup-routines SKILL.md) — no orch switch`,
  }));
}

/** Registers one declaration per shipped routine definition; loader faults propagate, no partial list. */
export function registerRoutines(dir: string = ROUTINES_DIR): void {
  for (const entry of routineSettings(dir)) defineSetting(entry);
}
