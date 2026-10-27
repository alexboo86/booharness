// Shared lead-only registrations for Claude-family settings and Codex hooks.json.
// Use the installer's command builder, merger and ownership proof so repoints
// invalidate Codex trust, duplicate definitions are removed, and foreign hooks survive.
export function installLeadHooks(hooks, repo, matcher, ensureHook, hookCommand, harnessHookScript) {
  const result = Object.fromEntries([
    ['lead_context', 'PostToolUse', 'lead-context-hook.mjs'],
    ['lead_chat_prompt', 'UserPromptSubmit', 'lead-chat-hook.mjs'],
    // After chat, as its own command: ensureHook appends, it does not rewrite the chat entry.
    ['lead_task_router', 'UserPromptSubmit', 'lead-task-router.mjs'],
    ['lead_chat_tools', 'PostToolUse', 'lead-chat-hook.mjs'],
  ].map(([key, event, script]) => [key, ensureHook(hooks, event, matcher, script, hookCommand(repo, script))]));
  // Empty matchers are Claude-family lead settings; Codex hooks.json uses .*.
  // Do not register a Codex watcher: asyncRewake waking it is not established
  // by the task 2139 probe (memory 14696).
  if (matcher !== '') return result;
  const script = 'lead-chat-watch.mjs';
  // The harness form of the command, not a name inside it: a user's
  // `node /personal/my-lead-chat-watch.mjs` took the watcher's fields (task 2396).
  const command = hookCommand(repo, script);
  const owns = (hook) => hook.command === command || harnessHookScript(hook.command) === script;
  let state = ensureHook(hooks, 'Stop', matcher, script, command);
  const entry = hooks.Stop.find((group) => group.hooks?.some(owns));
  let watcher;
  entry.hooks = entry.hooks.filter((hook) => {
    if (!owns(hook)) return true;
    if (watcher) { state = 'repointed'; return false; }
    watcher = hook;
    return true;
  });
  if (watcher.type !== 'command' || watcher.asyncRewake !== true || watcher.timeout !== 7200) {
    if (state !== 'installed') state = 'repointed';
    Object.assign(watcher, { type: 'command', asyncRewake: true, timeout: 7200 });
  }
  result.lead_chat_watch = state;
  return result;
}
