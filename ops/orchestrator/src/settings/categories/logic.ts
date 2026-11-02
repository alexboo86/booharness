import { defineSetting } from '../registry.ts';

export function registerLogic(): void {
  for (const [pairing, label, value, reads] of [
    ['authorReviewer', 'Separate author and reviewer', 'different-family', 'ops/orchestrator/src/seats-create.ts:361-362,370-371,417-427: author/coauthor family and resolved model step aside.'],
    ['debaterDebater', 'Separate debaters', 'different-model', 'ops/orchestrator/src/seats-create.ts:444-468 and seats-prompt.ts:188-192: resolved sibling models differ.'],
    ['planAuthorCritic', 'Separate planner and critic', 'different-family', 'ops/orchestrator/src/seats-create.ts:361-392,417-427: author/coauthor family and resolved model step aside; Claude lead exception retained.'],
  ]) {
    defineSetting({
      key: `logic.independence.${pairing}`, label, category: 'logic', group: 'safety',
      tier: 'advanced', control: 'select', class: 'operator-only', scope: 'install', type: 'enum',
      default: value, options: ['different-family', 'different-model', 'none'], apply: 'next-seat',
      help: `Choose whether the pair must use different families and models, different actual models, or neither; default keeps ${value === 'different-family' ? 'different families and models' : 'different models'}. Less separation weakens independent review.${pairing === 'planAuthorCritic' ? ' The existing Claude-lead exception for plan critics still applies.' : ''}`,
      reads,
    });
  }
  defineSetting({
    key: 'logic.recheckMode', label: 'Who rechecks fixes', category: 'logic', group: 'safety',
    tier: 'advanced', control: 'select', class: 'operator-only', scope: 'install', type: 'enum',
    default: 'auto', options: ['auto', 'same', 'new'], apply: 'live',
    help: 'Choose who checks a correction: default Auto keeps the choice based on which file paths changed. Other choices always reuse the previous reviewer or always request a new one.',
    reads: 'ops/orchestrator/src/seats-verify.ts:50-69: automatic same/new correction-delta rule.',
  });
}
