// Same checks, order and errors as the legacy remote-exec.mjs validator.
function hasHeaderFields(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === 'args,command,cwd,env';
}

function hasCommandFields(value) {
  return typeof value.cwd === 'string' && !!value.cwd &&
    typeof value.command === 'string' && !!value.command &&
    Array.isArray(value.args) && value.args.every((arg) => typeof arg === 'string');
}

function hasEnvironment(env) {
  return env !== null && typeof env === 'object' && !Array.isArray(env) &&
    Object.entries(env).every(([key, val]) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) && typeof val === 'string');
}

export function parseHeader(line) {
  const value = JSON.parse(line);
  if (!hasHeaderFields(value) || !hasCommandFields(value) || !hasEnvironment(value.env)) {
    throw new Error('invalid remote execution header');
  }
  return value;
}

const OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// A spawn fails or truncates on NUL, and a later object merge must not see these keys.
function isSpawnSafe({ cwd, command, args, env }) {
  const texts = [cwd, command, ...args, ...Object.keys(env), ...Object.values(env)];
  return !texts.some((text) => text.includes('\0')) && !Object.keys(env).some((key) => OBJECT_KEYS.has(key));
}

// Windows environments are case-insensitive and the win32 job holder adds every
// header key to one EnvironmentVariables block: PATH and Path in one header crash
// the holder at startup (exit 97). Refuse the collision at the validation boundary.
function caseDistinctEnv(env) {
  const folded = new Set();
  for (const key of Object.keys(env)) {
    const lower = key.toLowerCase();
    if (folded.has(lower)) return false;
    folded.add(lower);
  }
  return true;
}

// Protocol v1 adds a required execution policy; SSH does not accept that field.
export function parseExecHeader(line) {
  const value = JSON.parse(line);
  if (!value || !['seat', 'bootstrap'].includes(value.kind)) {
    throw new Error('invalid remote execution header');
  }
  const { kind, ...legacy } = value;
  if (!isSpawnSafe(parseHeader(JSON.stringify(legacy)))) {
    throw new Error('invalid remote execution header');
  }
  if (!caseDistinctEnv(value.env)) {
    throw new Error('invalid remote execution header: env keys collide case-insensitively');
  }
  return value;
}
