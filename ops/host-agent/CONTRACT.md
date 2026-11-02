---
id: ops-host-agent
owner: domain-harness
paths:
  - ops/host-agent/**
  - scripts/test-orch-host-agent.mjs
entry: ops/host-agent/index.mjs
layer: harness
---
# Host-agent transport and standalone artifact

## Purpose

Owns the standalone host-agent wire specification, dependency-free execution
transport primitives, versioned standalone agent bundle construction/verification,
the outbound host-agent core, and per-user installation/update. The core
pairs/authenticates, enforces host execution policy, owns process trees and reverse
loopback forwards. Runtime transfer and orch daemon wiring remain later slices; no
LAN listener is exposed.

## Public API

Import through `index.mjs`; importing it performs no I/O or process-global mutation.
[PROTOCOL.md](PROTOCOL.md) is the single owner of wire messages and lifecycle semantics.

| Export | Description |
| --- | --- |
| `runAgent` | Start the outbound TLS agent with origin, agentVersion, statePath, optional pair/approval/onPaired, local update-switch, policy, backoff and log options. Return a promise and idempotent stop function; the promise resolves with the terminal reason. Authenticate and pin before HTTP/2/update bytes, authorize bootstrap execs, refuse unavailable seat runtimes, kill owned trees/forwards on loss, and report a persisted update outcome once after reconnection. No I/O occurs until called. |
| `buildBundle` | Synchronously build a static import closure into a new output directory; options: entry (module-relative POSIX path), outputDir, version, and optional sourceDir (defaults to this installed module). Return the manifest. |
| `verifyBundle` | Synchronously verify a bundle directory's manifest, exact file set, sizes and SHA-256 hashes; return the manifest or throw naming the offending file. |
| `parseHeader` | Parse the legacy SSH four-field JSON header; unchanged validation/errors. |
| `parseExecHeader` | Parse the v1 header with a required kind (seat or bootstrap), refusing env keys that collide case-insensitively (the win32 job holder builds one case-insensitive env block and exits 97 on a duplicate). |
| `openExecStream` | Orch's HTTP/2 client opens an accepted execution ID's request on its accepted TLS socket; agent is the HTTP/2 server on its outgoing socket. |
| `pipeWithBackpressure` | Promise-based native stream pipeline; forwards native pipeline options. |
| `pipeExec` | Attach an already-spawned child's stdio to an accepted agent-side exec stream; require a platform `killTree(pid)` callback. Resolve `{code,signal,pid}` after output drain and scheduling exit trailers; reject on transport/process I/O failure. |
| `sendExitTrailers` | Schedule terminal HTTP/2 response trailers and end the writable half. Caller supplies the real exit result and an agent server stream responded with `waitForTrailers:true`. |
| `readExecOutput` | Orch demultiplexes bounded output frames to caller-owned stdout/stderr writables; resolves when output ends, rejects invalid/truncated frames; does not end destinations. |
| `installAgent` | Verify and unpack a tar bundle into a per-user installation, register the platform supervisor, and start it. A failure deregisters and removes the partial installation. |
| `uninstallAgent` | Stop and deregister the per-user supervisor, then remove the install root including credentials and pairing secrets. |
| `stageArtifact` | Bound, hash, safely unpack and verify an update beside installed versions; never execute it. |
| `activateStaged` | Atomically switch to a verified newer bundle and restart; a failed start restores/restarts the previous version and reports rollback. |
| `parsePairing` | Parse the one-line QR pairing payload without putting its secret in argv. |
| `installRoot` | Return the platform-specific per-user installation root. |
| `readPointer` | Read and validate the current-version pointer shape. |

## Inputs

- Bundle entry, source/output directories and explicit nonempty version. The output directory must not exist; its parent must exist. Manifest paths are module-relative POSIX paths.
- JSON header text. Shape validation is not path, command or environment authorization.
- Authenticated HTTP/2 sessions, one-use exec/update IDs, and accepted exec/update streams.
- Installer QR JSON on stdin, bounded ustar artifacts, caller-controlled homes and injected supervisors for tests. Updates have no URL/path input.
- Child process with piped stdin/stdout/stderr and a nonthrowing, idempotent real tree killer.
- Caller-owned output writables and process exit metadata.

## Outputs

- Standalone bundle files preserving source-relative layout, plus manifest.json containing version, entry, and sorted file records (path, byte size, SHA-256). No timestamps or repository imports.
- Parsed headers without coercion; invalid headers throw.
- Raw stdin, framed stdout/stderr, exit trailers and cancellation of owned trees.
- Promises reject on stream failures; callers must handle rejections and consume/validate
  trailers (missing trailers never mean success).
- Per-user launchd/systemd/Task Scheduler definitions, verified version directories and atomic current pointers. Uninstall leaves no credential.

## Invariants

- Only Node built-ins; no repository imports outside this module and no new dependencies.
- No listener, spawn, authentication, host environment mutation or policy bypass at import time.
- Bundle imports are static relative files or explicit node: built-ins only. Reject dynamic imports, escaping/absolute paths and symlinks; verification also rejects missing, extra, changed, duplicate and traversing manifest paths, Windows device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9; any extension, any casing) and other unsafe path characters. Build reads/validates the closure before creating output.
- Import scanning is conservative, without evaluating source: comments, strings, regex and nested template expressions are distinguished. Slash syntax that is unambiguous division (after a non-keyword identifier, a number or `]`) lexes as an operator; ambiguous slashes (after `)` and `}`), escaped/non-ASCII identifiers and noncanonical URL/path spellings fail closed. Use explicit file imports; there is no package or extension resolution.
- The import closure is a layout guarantee about our own source, not a sandbox. It covers ECMAScript `import`/`export` syntax only: `createRequire`, `import.meta.resolve`, Worker constructor URLs and built-in module loading can all load code the scan cannot see.
- Bundle hashes establish byte integrity, not signing authority. Source and output directories must be caller-controlled and quiescent during the synchronous operation. Install/update accepts only regular tar entries, verifies before execution, and the pinned authenticated link is the sole update-byte source.
- Typed approval is coalesced across reconnects in one agent run. Pending rotation pins carry a ten-minute expiry and expired pins never promote. State and pairing files are mode 0600 on Unix; Windows DACLs are task 3529.
- Update activation refuses downgrade/busy work and accepts each activation ID once. A failed new start rolls the pointer back and restarts the old verified bundle; rollback failure is reported explicitly. The restarted agent sends the persisted outcome over authenticated control once, then removes it.
- `ready.json` deliberately marks process launch before the first daemon connection: the supervisor uses it only as a start boundary, never as proof of pairing, authentication or a healthy control link.
- SSH validation accepts exactly its original four fields; v1 requires the execution kind.
- Agent dials TLS outward, but serves HTTP/2 only after raw-TLS pairing/auth and switch.
  Orch is the HTTP/2 client and opens all requests; no server-initiated requests or push.
- Transport helpers are not an authentication boundary: callers authenticate before the
  HTTP/2 handoff, authorize offers and validate headers before spawning. Agent responds
  to accepted exec requests with `waitForTrailers:true`; connection-level control loss
  must destroy exec streams. Callers own pre-auth limits and connection bookkeeping.
- Seat execution delegates to a verified daemon-commit runtime bundle on the host. Core
  never imports bundle/repository code or pre-resolves host environment/toolchain paths;
  bundle transfer, verification and launching remain later-slice work specified in PROTOCOL.md.
- Stream reset or loss kills the attached command tree once. Clean stdin EOF is not a
  transport reset; seat callers keep relay stdin open until exit to preserve its EOF-kill policy.
- A real platform killer is mandatory: POSIX process groups, Windows kill-on-close Job Objects.
- Output remains byte-preserving per channel, flow-controlled and bounded to 64 KiB frames;
  exit trailers are sent only after both output channels drain.

## Dependencies

Node.js built-ins only (HTTP/2, events, streams, filesystem, path, URL, crypto and module metadata). No package install.

## Tests

`node --test --test-concurrency=1 scripts/test-orch-host-agent-core.mjs` (`scripts/test-orch-host-agent-core.mjs` not in this kit) exercises
runAgent through a real TLS/raw-prelude/inverted HTTP/2 peer: pin-before-secret,
typed approval, credential persistence/revocation, rotation, literal bootstrap
exec output/exit, process-tree kill on loss/reset, reconnect, policy refusals and
reverse loopback forwarding (bidirectional bytes, 32-socket cap, close/loss cleanup).
The fixture supplies the Windows SystemRoot needed by Node; the core never
inherits host environment variables into the command environment.

`node --test --test-concurrency=2 scripts/test-orch-host-agent-bundle.mjs` (`scripts/test-orch-host-agent-bundle.mjs` not in this kit) exercises static import closure, deterministic manifests, standalone execution and unsafe/tampered bundle refusals. This test is registered in scripts-test-orch and discovered by the non-live suite filename selector.

`node --test --test-concurrency=2 scripts/test-orch-host-agent-install.mjs` (`scripts/test-orch-host-agent-install.mjs` not in this kit) uses a temporary HOME and fake or mocked supervisors to prove verified install, hostile archive and pairing refusal before start, update, rollback, Windows PID ownership and credential-free uninstall without touching real service managers. It also executes the shipped wrappers against a fixture CLI to prove `--home` forwarding.

`node --test --test-concurrency=2 scripts/test-orch-host-agent.mjs` (`scripts/test-orch-host-agent.mjs` not in this kit) exercises public helpers at
local HTTP/2/process boundaries, header acceptance/rejection, exit trailers and cancellation.
The loopback uses real TLS on 127.0.0.1 and a public test-only certificate/key fixture.
Agent dials, orch opens HTTP/2 requests on the accepted socket, and agent serves them
without listening. It proves TLS/role inversion, output/exit and tree cleanup, not pairing,
raw-prelude handoff, runtime-bundle verification or host execution policy.
Existing SSH coverage remains `scripts/test-orch-remote.mjs` (not in this kit) and
`scripts/test-orch-remote-exec-disconnect.mjs` (not in this kit), unchanged.

## Owner

`domain-harness`.

## Changelog

- Task 3459 R10 S5: per-user launchd/systemd/Task Scheduler installers, verified pinned-link updates with rollback, reconnect-coalesced approval and expiring pending rotation pins.
- R10 S1b review: line comments end at every line terminator (\r, U+2028, U+2029); string braces no longer close an export clause; unambiguous division lexes; bundle paths refuse Windows device names and glob/control characters; scan boundary (layout guarantee, not sandbox) documented.
- Task 3459 R10 slice 1: introduce protocol v1 and standalone transport helpers;
  extract the SSH validator without changing remote execution behavior.
- Plan-critic follow-up: raw-TLS authentication followed by inverted HTTP/2 roles;
  specify verified commit-pinned host runtimes without coupling the agent core to the repo.
