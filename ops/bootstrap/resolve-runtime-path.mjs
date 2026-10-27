#!/usr/bin/env node
// Resolve AI-provider binaries from a canonical search path that does not
// depend on the caller's ambient PATH.
//
// Measured on the live Mac (lead, 2026-08): three different PATHs exist.
//   ~/.zshenv          (ssh / every automatic shell)  — only ~/.cargo/bin
//   zsh -l             (login)                        — homebrew, /usr/local/bin,
//                                                       /pkg/env/global/bin
//   interactive-only rc                               — ~/.kimi-code/bin, ~/.grok/bin
//
// launchd and Paseo are never interactive, so reading the current process PATH
// (or sourcing the interactive-only rc) makes kimi/grok look "broken" when they are installed.
// This module builds the search path from HOME + known locations and refuses
// when a required provider is not there. The same answer comes back from an
// interactive shell, from launchd, and from `env -i`.
//
//   node ops/bootstrap/resolve-runtime-path.mjs --require --json
//   node ops/bootstrap/resolve-runtime-path.mjs --home <dir> --platform darwin --require
//   node ops/bootstrap/resolve-runtime-path.mjs --clis
//   node ops/bootstrap/resolve-runtime-path.mjs --families [--home <dir>]
//
// --families prints the setup wizard's answer for its families question: one
// row per family and the list of the families that work here. It reads only.
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalSearchDirs, requiredCliNames } from '../../scripts/lib/runtime-search.mjs';
export { canonicalSearchDirs, requiredCliNames, REQUIRED_PROVIDERS, FAMILY_CLI_NAMES } from '../../scripts/lib/runtime-search.mjs';

function isCandidate(file) {
  try {
    const st = lstatSync(file);
    return st.isFile() || st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * @param {string} name
 * @param {string[]} searchDirs
 * @param {{ platform?: string }} [options]
 */
export function resolveOnPath(name, searchDirs, options = {}) {
  const platform = options.platform || process.platform;
  // Windows executable extensions precede npm's extensionless POSIX shim.
  // Keep the extensionless Node-script fixture/install as the last runnable choice.
  const names = platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name, `${name}.ps1`] : [name];
  for (const dir of searchDirs) {
    for (const fileName of names) {
      const candidate = path.join(dir, fileName);
      if (isCandidate(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * CLI names the config requires, deduplicated, or Claude Code when
 * `families.enabled` is absent. `repoRoot` selects the checkout; the default
 * is the checkout that holds this file.
 *
 * @param {{ repoRoot?: string }} [options]
 * @returns {readonly string[]}
 */
// Neither Pi nor node need be on a terminal's PATH. Both the login launcher
// and the families probe use the installed package's actual entry.
export function pinnedPi() {
  const packageFile = fileURLToPath(new URL(
    '../pi-runtime/node_modules/@earendil-works/pi-coding-agent/package.json', import.meta.url));
  const pkg = JSON.parse(readFileSync(packageFile, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi;
  if (typeof bin !== 'string' || !bin) throw new Error('missing Pi bin');
  const entry = path.resolve(path.dirname(packageFile), bin);
  if (!statSync(entry).isFile()) throw new Error('missing Pi entry');
  return entry;
}

/**
 * @param {{ home?: string, platform?: string, systemDirs?: string[], nodeDir?: string, repoRoot?: string }} [options]
 */
export function resolveProviders(options = {}) {
  const searchDirs = canonicalSearchDirs(options);
  const found = {};
  const missing = [];
  for (const name of requiredCliNames(options)) {
    const resolved = resolveOnPath(name, searchDirs, options);
    if (resolved) found[name] = resolved;
    else missing.push(name);
  }
  return { found, missing, searchDirs };
}

/**
 * @param {{ home?: string, platform?: string }} [options]
 */
export function resolveRequiredProviders(options = {}) {
  const result = resolveProviders(options);
  if (result.missing.length > 0) {
    const searched = result.searchDirs.join(path.delimiter);
    throw new Error(
      `required provider(s) not found: ${result.missing.join(', ')}. ` +
        `Searched the canonical path (not the process PATH): ${searched}`,
    );
  }
  return result;
}

export function formatSearchPath(options = {}) {
  const platform = options.platform || process.platform;
  const sep = platform === 'win32' ? ';' : ':';
  return canonicalSearchDirs(options)
    .map((dir) => dir.split(path.sep).join(platform === 'win32' ? '\\' : '/'))
    .join(sep);
}

export function posixSearchPath(options = {}) {
  return canonicalSearchDirs({ ...options, platform: options.platform || 'darwin' })
    .map((dir) => dir.split(path.sep).join('/'))
    .join(':');
}

// Imports scripts/lib/harness-config.mjs. orchFixtureRepo copies both files;
// a fixture that copies only this file cannot load it.
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const opts = {};
  const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--home' || arg === '--platform') {
      opts[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else if (arg === '--system-dirs') {
      // Test seam; see canonicalSearchDirs. An empty value means "no machine-wide
      // directories at all", which is what an isolated suite wants.
      opts.systemDirs = (argv[i + 1] || '').split(':').filter(Boolean);
      i += 1;
    } else if (arg.startsWith('--')) {
      flags.add(arg.slice(2));
    }
  }
  if (flags.has('families')) {
    // Not awaited at the top level and not a static import: the step imports
    // this module, and a top-level await on it never settles.
    const home = path.resolve(opts.home || process.env.HARNESS_HOME || process.env.HOME || process.env.USERPROFILE || os.homedir());
    import('./wizard-steps/families.mjs').then(({ defaultCheckLogin, defaultFindCli, probeFamilies }) => {
      const { rows, working } = probeFamilies({ findCli: defaultFindCli, checkLogin: defaultCheckLogin, home });
      process.stdout.write(`${rows.join('\n')}\nworks here: ${JSON.stringify(working)}\n`);
    });
  } else {
    if (flags.has('clis')) {
      for (const name of requiredCliNames(opts)) {
        process.stdout.write(`${name}\n`);
      }
      process.exit(0);
    }
    const result = resolveProviders(opts);
    if (flags.has('json')) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.missing.length === 0) {
      for (const name of Object.keys(result.found)) {
        process.stdout.write(`${name}\t${result.found[name]}\n`);
      }
    } else {
      process.stderr.write(
        `required provider(s) not found: ${result.missing.join(', ')}\n` +
          `canonical search path:\n  ${result.searchDirs.join('\n  ')}\n`,
      );
    }
    if (flags.has('require') && result.missing.length > 0) {
      process.exit(1);
    }
  }
}
