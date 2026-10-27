// Kimi owns its TOML spelling: login can reserialize literal quotes as basic
// quotes. Check script + runtime meaning, accepting both forms and CRLF.
export function checkKimiHookWiring({ configPath, configured, check, readHome }) {
  check(configured, `${configPath} — kimi/config-file${configured ? '' : ': absent — run node ops/bootstrap/install-harness.mjs'}`);
  if (!configured) return;
  let config;
  try {
    config = readHome(configPath, 'kimi hook wiring');
  } catch (error) {
    check(false, `${configPath} — kimi/config-file: unreadable: ${error.message}`);
    return;
  }
  for (const [id, pattern] of [
    ['rtk-routing', /codex-rtk-hook\.mjs\\?" kimi/],
    // Without the runtime argument this takes Claude's additionalContext
    // branch, which Kimi never shows (live acceptance 2026-09-14).
    ['lessons-deny', /domain-lessons-hook\.mjs\\?" kimi/],
    ['lessons-forget', /event = "PreCompact"\r?\ncommand = ["'][^\n]*session-start\.mjs\\?["'][^\n]*/],
  ]) {
    const wired = pattern.test(config ?? '');
    check(wired, `${configPath} — kimi/${id}${wired ? '' : ': not wired — run node ops/bootstrap/install-harness.mjs'}`);
  }
}
