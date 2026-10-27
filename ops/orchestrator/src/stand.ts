// The A/B stand is an explicit per-seat opt-in. Never accept a client-supplied
// directory or arbitrary environment from seat_create.
import path from 'node:path';

export const STAND_ARMS = ['base', 'no-lessons', 'no-codegraph', 'context-mode', 'pi-condense', 'context-pruning', 'agent-lsp', 'probe', 'gitnexus', 'jcodemunch', 'openviking', 'sleev', 'obs-mask', 'hashline-edit', 'hashline-edit-451', 'hashline-edit-500', 'sol-pi', 'billion-context', 'codex-edit', 'codebase-memory-mcp', 'open-codebase-index', 'aider-repo-map', 'serena'] as const;
export type StandArm = (typeof STAND_ARMS)[number];

export function isStandArm(value: unknown): value is StandArm {
  return typeof value === 'string' && (STAND_ARMS as readonly string[]).includes(value);
}

export function standEnv(stateDir: string, arm: StandArm, inheritedPath: string): Record<string, string> {
  const root = path.join(stateDir, 'ab-stand', 'arms', arm);
  return {
    // codex-edit needs no custom env: its filtered package and adjacent config
    // live under this same isolated Pi agent directory, never the live profile.
    HOME: path.join(root, 'home'),
    PI_CODING_AGENT_DIR: path.join(root, 'agent'),
    PI_PACKAGE_DIR: path.join(root, 'packages'),
    PI_CODING_AGENT_SESSION_DIR: path.join(root, 'sessions'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_CONFIG_HOME: path.join(root, 'home', '.config'),
    ...(arm === 'open-codebase-index' ? { OLLAMA_HOST: 'http://127.0.0.1:11498' } : {}),
    npm_config_cache: path.join(root, 'cache', 'npm'),
    CONTEXT_MODE_DIR: path.join(root, 'context-mode'),
    // pi-hashline-edit-pro writes config, its SQLite hash store and session
    // claims here; keep them inside the per-arm state, never the live home.
    // Each hashline arm gets its own directory. 4.5.1 store version 9 deletes
    // undo and snapshots when it opens a 4.4.4 store (version 8). 5.0.0 is
    // also version 9 and still must not open another arm's store.
    PI_HASHLINE_DIR: path.join(root, 'hashline'),
    // billion-context-pi runs npm view/install at session start unless this is
    // off; its acp_delegate child spreads this env, so the child keeps it too.
    ...(arm === 'billion-context' ? { ACP_AUTO_UPDATE: '0' } : {}),
    ...(arm === 'gitnexus' ? { GITNEXUS_HOME: path.join(root, 'gitnexus'), GITNEXUS_STORAGE_ROOT: path.join(root, 'gitnexus', 'storage'), GITNEXUS_MCP_READ_ONLY: '1', GITNEXUS_NO_UPDATE_NOTIFIER: '1' } : {}),
    ...(arm === 'jcodemunch' ? { CODE_INDEX_PATH: path.join(root, 'code-index'), JCODEMUNCH_SHARE_SAVINGS: '0', JCODEMUNCH_USE_AI_SUMMARIES: '0', JCODEMUNCH_PERF_TELEMETRY: '0', JCODEMUNCH_ALLOW_REMOTE_SUMMARIZER: '0', JCODEMUNCH_ALLOW_PAID_SUMMARIES: '0' } : {}),
    // sleev: stable channel, text charts, and self-update checks closed by pointing
    // SLEEV_NPM_REGISTRY and UPDATES_BASE_URL at an unreachable local endpoint
    // (the same literals as ops/ab-stand/sleev.json updateOffUrl). Guest mode keeps
    // api.sleev.ai reachable: the vendor control plane gates guest legal terms and
    // usage (see ops/ab-stand/README.md for every network destination).
    ...(arm === 'sleev' ? { SLEEV_CHANNEL: 'stable', SLEEV_TUI_GRAPHICS: 'text', SLEEV_NPM_REGISTRY: 'http://127.0.0.1:9/sleev-stand-update-check-off', UPDATES_BASE_URL: 'http://127.0.0.1:9/sleev-stand-update-check-off' } : {}),
    CBM_CACHE_DIR: path.join(root, 'cbm'),
    RTK_DB_PATH: path.join(root, 'rtk.db'),
    ORCH_SEAT_STAND_ARM: arm,
    ...(arm === 'aider-repo-map' ? { AIDER_ANALYTICS_DISABLE: '1', AIDER_AUTO_COMMITS: 'false', AIDER_CHECK_UPDATE: 'false', AIDER_GITIGNORE: 'false', AIDER_SHOW_MODEL_WARNINGS: 'false', AIDER_MODEL: 'gpt-4o-mini', AIDER_CHAT_HISTORY_FILE: path.join(root, 'cache', 'aider-chat.md'), AIDER_INPUT_HISTORY_FILE: path.join(root, 'cache', 'aider-input'), AIDER_LLM_HISTORY_FILE: path.join(root, 'cache', 'aider-llm') } : {}),
    PATH: [path.join(root, 'npm', 'node_modules', '.bin'), path.join(root, 'venv', 'bin'), inheritedPath].join(path.delimiter),
  };
}
