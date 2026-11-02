import { JEV_THRESHOLD_DEFAULTS, JEV_THRESHOLD_KEYS } from '../../../../../scripts/lib/harness-settings.mjs';
import { defineSetting } from '../registry.ts';

/**
 * Jev score thresholds for the plain-Node routers and checks (task 3459 C4b). The default
 * percents live in scripts/lib/harness-settings.mjs — one place — because those files cannot
 * import this registry at hook start; both sides read the same map, so no literal is copied.
 * Routers and hooks are install scope (one install's taste); a check that must judge every
 * checkout alike is project scope and ships its value in .agents/harness-settings.json.
 */
export function registerJevScripts(): void {
  defineSetting({
    key: JEV_THRESHOLD_KEYS.lessonDelivery, label: 'Full lesson relevance', category: 'jev', group: 'automation',
    tier: 'advanced', control: 'slider', class: 'user', scope: 'install', type: 'int',
    default: JEV_THRESHOLD_DEFAULTS[JEV_THRESHOLD_KEYS.lessonDelivery], bounds: { min: 0, max: 100 }, apply: 'live',
    help: 'Send a lesson in full when its Jev relevance score reaches this percentage; default 60 keeps the current cutoff. Lower-scoring lessons remain listed for lookup on demand.',
    reads: 'Wired: ops/bootstrap/lesson-router.mjs:163 delivers a full body only at score >= threshold/100 (today 0.6) through installJevThreshold in scripts/lib/harness-settings.mjs.',
  });
  defineSetting({
    key: JEV_THRESHOLD_KEYS.domainPage, label: 'Domain page relevance', category: 'jev', group: 'automation',
    tier: 'advanced', control: 'slider', class: 'user', scope: 'install', type: 'int',
    default: JEV_THRESHOLD_DEFAULTS[JEV_THRESHOLD_KEYS.domainPage], bounds: { min: 0, max: 100 }, apply: 'live',
    help: 'Attach a domain knowledge page to the lead’s first substantial task prompt when its Jev relevance score reaches this percentage; default 50 keeps the current cutoff.',
    reads: 'Wired: ops/bootstrap/lead-task-router.mjs:175 admits a domain page at score >= threshold/100 (today 0.5) through installJevThreshold in scripts/lib/harness-settings.mjs.',
  });
  defineSetting({
    key: JEV_THRESHOLD_KEYS.historyGate, label: 'History rejection score', category: 'jev', group: 'automation',
    tier: 'advanced', control: 'slider', class: 'operator-only', scope: 'project', type: 'int',
    default: JEV_THRESHOLD_DEFAULTS[JEV_THRESHOLD_KEYS.historyGate], bounds: { min: 0, max: 100 }, apply: 'live',
    help: 'Operator-only: fail added knowledge-page lines when the manually run check-knowledge-history scores them at or above this percentage as progress or history rather than a map of how the code works; default 60 keeps the current cutoff. This judgement does not run in check:commit.',
    reads: 'Wired: scripts/check-knowledge-history.mjs:355 fails a batch at score >= threshold/100 (today 0.6) through projectJevThreshold; the value ships in .agents/harness-settings.json.',
  });
}
