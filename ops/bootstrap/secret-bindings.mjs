// Which environment variable an MCP server needs, and which stored secret
// fills it — read from the MCP SSOT (ops/bootstrap/mcp-servers*.json), never
// listed again here. node: builtins only: mcp-role-gate.mjs imports this file
// and install-macos-fixture.mjs copies both standalone into a fixture repo.
//
// `env` is what the vendor reads, `secret` is what the machine stores. They
// differ because Bright Data reads a GENERIC `API_TOKEN`, and a secrets file
// shared by six servers cannot have six keys called that.
import { readFileSync } from 'node:fs';

// KEY=value lines, comments and blanks skipped; CRLF tolerated. A missing
// file parses as empty so callers decide what absent secrets mean.
export function loadSecrets(file) {
  const secrets = {};
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch { return secrets; }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#') || !line.includes('=')) continue;
    const cut = line.indexOf('=');
    secrets[line.slice(0, cut).trim()] = line.slice(cut + 1).trim();
  }
  return secrets;
}

export function secretBindings(spec) {
  const declared = spec?.env_from_secrets;
  if (!Array.isArray(declared)) return [];
  return declared.map((entry) => {
    if (!entry || typeof entry !== 'object' || !entry.env || !entry.secret) {
      throw new Error(
        `env_from_secrets entries must be { env, secret }; got ${JSON.stringify(entry)}`,
      );
    }
    if (entry.optional !== undefined && typeof entry.optional !== 'boolean') {
      throw new Error(`env_from_secrets optional must be a boolean; got ${JSON.stringify(entry)}`);
    }
    return { env: String(entry.env), secret: String(entry.secret), ...(entry.optional === true ? { optional: true } : {}) };
  });
}

// Missing required bindings refuse the server; optional ones leave no env key.
export function resolveSecretEnv(spec, valueFor) {
  const env = {};
  for (const { env: envName, secret, optional } of secretBindings(spec)) {
    const value = valueFor(secret);
    if (!value) {
      if (optional) continue;
      return null;
    }
    env[envName] = value;
  }
  return env;
}
