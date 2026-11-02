# Orch host-agent protocol v1

This is the single normative owner of the wire message set. [The module contract](CONTRACT.md)
describes the helper API, not another protocol. This slice supplies primitives only;
listeners, pairing, credentials, forwarding, rotation and updates are later slices.

## Transport and trust boundary

Orch accepts TLS on a **separate, explicitly configured LAN listener**. The agent
always dials out to that listener; it never listens on a network port. TLS roles and
HTTP/2 roles are deliberately different: orch is the TLS server but, **after raw-TLS
authentication**, the HTTP/2 client; the agent is the TLS client but HTTP/2 server.
HTTP/2 servers cannot initiate request streams; no push-stream workaround is used.
No HTTP/1 downgrade, cleartext LAN listener, SSH tunnel, proxy discovery or
unauthenticated exec is allowed. Use TLS 1.3 with application ALPN `orch-host-agent/1`
(the raw JSON prelude is not standard ALPN `h2`). Addresses are operator-configured
`https://host:port` origins (no userinfo, path, query or fragment). Pairing pins the
entire SHA-256 fingerprint of orch's DER leaf certificate: 32 bytes represented as
64 lowercase hex digits, not a prefix. Normal connections require that pin before
sending credentials; a PKI-valid certificate alone cannot replace it.

A new TLS connection is quarantined until authenticated. From TCP accept allow at
most 10 seconds through TLS, hello, authentication and the switch barrier, and at
most 65,536 received application bytes before authentication, across all JSON lines.
Bound TLS handshakes and concurrent connections too. There is **no HTTP/2 session or
stream before authentication**. Exceeding time/bytes or an unexpected message closes
the socket without starting work. Human confirmation does not suspend the timer:
on expiry reconnect and repeat after confirmation. Never log secrets or put them
in URLs, argv, GOAWAY debug data or error bodies.

## Raw-TLS prelude, switch and control grammar

Before HTTP/2, each direction exchanges short UTF-8 JSON objects separated by LF:
agent `hello`, orch `hello`, agent `pair` or `auth`, orch `paired` or `authenticated`.
All pairing and credential authentication happens here, not in HTTP/2 headers or a
control stream. On success the agent sends `switch {version:1}`, and orch replies
`switch-ready {version:1}`. Failures close the raw socket; no HTTP/2 fallback.

After writing the final switch-ready LF, orch calls
`http2.connect(origin, {createConnection: () => acceptedTlsSocket})`. The agent,
after consuming that LF, attaches its **outgoing** TLS socket to a non-listening
`http2.createServer()` with `server.emit('connection', outgoingTlsSocket)`. No second
TLS handshake or connection occurs. The HTTP/2 client preface is sent by orch, never
by the agent. This role inversion does not change who authenticated whom.

The raw reader must pause at the exact LF boundary, remove its data listeners and
return any coalesced bytes after the LF to the socket before handing it to HTTP/2.
Never discard, decode as JSON, or double-consume preface/SETTINGS bytes. Install the
agent's server handler before resuming the socket. Switch/auth parsers and secrets
are released after handoff; raw JSON is invalid once HTTP/2 has started. The switch
barrier is connection-local, not a resumable session or authorization token.

Orch then opens `POST /v1/control`, `content-type: application/x-ndjson`, with both
halves open (`endStream:false`). Agent responds HTTP 200 with the same content type.
Orch request DATA contains commands; agent response DATA contains events. All other
HTTP/2 request streams are also opened by orch. Limit HTTP/2 header allocation,
flow-control windows, concurrent streams and buffering; disable push streams.

In both phases a JSON line excluding LF is at most 65,536 bytes. No multiline JSON,
duplicate keys, unknown properties/types or invalid UTF-8. The control-line reader
(slices 2 and 3) enforces the size bound, duplicate keys and UTF-8; `parseExecHeader`
sees an already decoded line and does not. Integers are safe
nonnegative JSON integers unless narrowed below. New operation IDs are strings matching
`[a-zA-Z0-9_-]{1,64}` and are unique for the connection; replies/references reuse
their operation's ID, but another operation cannot. No cross-connection replay.

Every control object has `type` and exactly the listed fields. Replies carry the
request's `id`. Secrets are base64url without padding except the typed secret below.

| Direction | Message and fields | Meaning |
| --- | --- | --- |
| Agent → orch | `hello {version:1, agentVersion, nodeVersion, platform, arch}` | First raw-TLS message; version strings max 64 bytes, platform is `win32`, `darwin` or `linux`; arch is `x64` or `arm64`. |
| Orch → agent | `hello {version:1, orchVersion, daemonCommit}` | Version agreed; no implicit negotiation/downgrade. Unsupported version gets `error` then close. |
| Agent → orch | `pair {id, mode, secret}` | Initial pairing only, as specified below. |
| Orch → agent | `paired {id, agentId, credential}` | Issued once after local approvals; credential is 32 random bytes. Authentication now succeeds. |
| Agent → orch | `auth {id, agentId, credential}` | Subsequent sessions authenticate after pinned TLS and hello. |
| Orch → agent | `authenticated {id, agentId}` | Raw-TLS authentication succeeded; host identity bound to this connection. |
| Agent → orch | `switch {version:1}` | Raw-TLS authentication complete; ready to become the HTTP/2 server. |
| Orch → agent | `switch-ready {version:1}` | Last raw-TLS line; orch becomes the HTTP/2 client on the accepted socket. |
| Either → peer | `error {id, code}` | `id` is null for a connection-level error; code is one of `version`, `auth`, `protocol`, `denied`, `busy`, `failed`, `no-runtime`. No secret or exception text. Pre-auth errors close; post-auth operation errors terminate that operation. |
| Orch → agent | `exec {id, header, runtimeCommit}` | Offer one execution; runtimeCommit is the hello daemonCommit for seat, null for bootstrap. |
| Agent → orch | `exec-ready {id}` | Policy and required runtime accepted; orch may open the exec stream. |
| Orch → agent | `runtime {id, commit, manifestSha256, size}` | Offer the daemon-commit runtime closure; manifest and transfer below. |
| Agent → orch | `runtime-ready {id}` | Agent may receive this runtime transfer. |
| Agent → orch | `runtime-staged {id, commit}` | Complete verified immutable runtime published; not an execution receipt. |
| Orch → agent | `forward-open {id, seatId, endpointId}` | Authorize a reverse loopback binding for one live seat; no arbitrary destination. |
| Agent → orch | `forward-ready {id, port}` | Loopback listener ready, port 1–65535. |
| Agent → orch | `forward-connect {id, forwardId}` | A local client accepted; orch may open a forward stream for this unique connection ID. |
| Orch → agent | `forward-close {id}` | Revoke binding, listener and its active connections; agent acknowledges with `forward-closed {id}`. |
| Orch → agent | `cert-rotate {id, fingerprint, certificate, activateAfter}` | New full pin, base64url DER certificate and UTC epoch milliseconds; see rotation below. |
| Agent → orch | `cert-rotate-ready {id}` | New pin persisted and certificate/fingerprint matched. |
| Orch → agent | `update {id, version, platform, arch, size, sha256}` | Push a bounded agent artifact for the authenticated host platform; see update below. |
| Agent → orch | `update-ready {id}` | Artifact may be streamed. |
| Agent → orch | `update-staged {id}` | Verified artifact staged atomically, not yet running. |
| Orch → agent | `update-activate {id}` | Activate once, only when this connection has no running commands or forwards. |
| Agent → orch | `update-result {status, version?, message?, at}` | After an activated restart, report the switch helper's activation or rollback outcome once, then remove the local result file. There is no acknowledgement and the file is removed after the send: a link loss after the send drops the result rather than replaying it, and an agent crash between the send and the removal reports it again on the next connection. A corrupt result file is reported as `rolled-back-or-failed` with a message naming the corrupt file, then removed. |

Only hello, pairing, authentication, error and switch messages are valid in the
raw-TLS prelude. No runtime, exec, update, forwarding or rotation before the successful
HTTP/2 switch. Prelude messages are invalid on control. An agent cannot issue exec
offers or select orch-side
destinations. Orch authorizes offers against its host/seat records; received command
output, repository text and model output never grant a capability.

## Pairing and credentials

Pairing exists only during an explicit local-operator-opened ten-minute window.
Secrets are generated with `crypto.randomBytes`, never reused, and erased on success,
expiry, cancellation or the fifth failed attempt. Count failed attempts atomically
**across all connections and both modes** for the window, including malformed pair
attempts. No per-IP reset. Closing the window closes its pending pairing connections.
Concurrent successful submissions consume the window once; only one wins. Reopening
requires a local operator action and new secrets. Never silently fall back between modes.

* **QR:** encode `{version:1,address,fingerprint,secret}` in the local QR. Secret is
  16 random bytes (128 bits), base64url. The agent pins the full supplied fingerprint
  before sending `pair {mode:"qr",...}`; any mismatch aborts without transmitting it.
* **Typed:** local orch UI shows the address, an 8-character secret uniformly sampled
  from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (40 bits), and a six-digit check code. Agent
  operator enters the address and secret. A quarantined TLS connection may retrieve
  the peer certificate, but sends neither the secret nor credentials before the agent
  operator compares and explicitly approves the locally computed code with orch's
  trusted local display. The orch operator also explicitly confirms its displayed code.
  A remotely received “confirmed” flag is never local approval. The agent pins the full
  observed fingerprint only after comparison, then sends `pair {mode:"typed",...}`.
  Timeout closes the connection; the operator may reconnect using that approved pin
  during the same still-open window. One install coalesces approval for the same
  certificate across reconnects, including an approval still pending at timeout.
  A mismatch cancels pairing, not a warning to bypass.

Define the check code exactly: HMAC-SHA256 with the uppercase ASCII typed secret as
key, and bytes `UTF8("orch-host-agent/check/v1\0") || SHA256(DER leaf certificate)` as
message. Read the first four digest bytes as unsigned big-endian, reduce modulo
1,000,000 and left-pad to six decimal digits. Both sides compute locally; the code is
never accepted as a substitute credential and never sent over the network. Its purpose
is to detect an intercepted certificate, not to add entropy to the typed secret.

Compare decoded fixed-length secrets and credentials with `crypto.timingSafeEqual`.
For wrong length/encoding, compare a fixed-length dummy value too before rejection;
no ordinary string comparison for secret material. Pairing failures use the same
`auth` error. Issue a fresh opaque 32-byte credential bound to the agent ID, persist
with owner-only permissions/OS secret storage, and persist the pin atomically before
success is shown. No plaintext credential in diagnostics. Credential revocation closes
all that identity's sessions and kills their commands. A lost credential/pin requires
explicit re-pairing; no trust-on-first-use recovery. An explicit new pairing window
can replace a host's stale credential/pin: keep the previous state intact until
`paired` succeeds, then atomically replace it. After pairing succeeds in that agent
run, reconnects authenticate with the new credential, never replaying the consumed
pairing secret, even if the switch barrier failed. Only one authenticated session per
agent identity; reject a second as `busy`, do not silently replace live work.

## Execution streams

Header is exactly `{cwd,env,command,args,kind}`. `cwd` and `command` are nonempty
strings; `args` is an array of strings; `env` is an object whose keys match
`[a-zA-Z_][a-zA-Z0-9_]*`, excluding `__proto__`, `constructor` and `prototype`, and
values are strings; `kind` is `seat` or `bootstrap`. No string holds a NUL.
No additional fields or coercion. The SSH compatibility validator deliberately
accepts exactly the old four fields, **without** `kind`. Header validation is shape
validation, not authorization: the agent separately enforces the authenticated host's
allowed roots, canonical path containment and permitted bootstrap operations before
spawn. Re-check containment when claiming an offer, not only at offer time, and
spawn with that checked canonical cwd. `seat` runs through the verified runtime bundle described below: orch must
not pre-resolve host paths, env or wrappers. `bootstrap` is implemented by the standalone
core under an explicit provisioning allowlist, never a policy bypass or shell fallback.

The spawn environment is `env` exactly, except for `bootstrap`, where the agent merges its own platform floor (`SystemRoot`, `PATH`, `TEMP`, `USERPROFILE` on win32; `HOME`, `PATH` on posix) *under* `env`: an `env` key always wins and no other host variable is inherited. The floor exists because the holders spawn with exactly the header's environment and a bare spawn dies before `main()` without the OS's own variables (win32 node aborts in `ncrypto::CSPRNG` without `SystemRoot`). A `seat` runs with exactly `env`.

After `exec-ready`, **orch** opens `POST /v1/exec/<id>` with
`content-type: application/octet-stream`, `endStream:false`. Agent matches a single
outstanding offer owned by that authenticated connection, validates policy/runtime,
spawns the command and responds 200 with `waitForTrailers:true`. An absent/duplicate/
unowned offer is rejected (403 and RST) without spawning. Header travels only in the
control offer, not in HPACK headers. One stream represents one command; at most 64
simultaneous execs per session, excess gets `busy` and no spawn.

* Orch request DATA → agent: raw stdin bytes, no text conversion. For bootstrap,
  request END_STREAM means stdin EOF, **not** kill. For seat, orch keeps this half
  open until the relay exits: early EOF retains remote-exec's existing EOF-kills-tree
  semantics. A reset/cancellation or connection loss always means kill.
* Agent response DATA → orch: multiplexed stdout and stderr frames. Each is one byte
  channel (`1` stdout, `2` stderr), four-byte unsigned big-endian payload length
  (1–65,536), then that many raw bytes. Empty output produces no frames. Preserve
  order within each channel; no total ordering is promised between channels. Frames
  may cross any HTTP/2 DATA boundary. Invalid/truncated frames reset the exec stream.
* Once the process closes **and both outputs have drained**, the agent ends its
  response with trailing HEADERS: `orch-exit-code` (decimal 0–4294967295, since a Windows NTSTATUS exit exceeds 31 bits, or empty for
  signal termination), `orch-exit-signal` (OS signal name, or empty), `orch-remote-pid`
  (positive decimal OS PID). At least code or signal is present. These correspond to
  `{code,signal,pid}` in the helper API; a missing trailer is failure, never success.
  Orch stops sending stdin and ends its request on receiving exit trailers if it
  has not already sent stdin EOF. Agent drains any in-flight stdin after child exit
  so both HTTP/2 halves can close, even when the command never read stdin.
  A spawn failure resets with INTERNAL_ERROR and sends `error {code:"failed"}` on
  control; it must not fabricate an exit code or PID.

**RST_STREAM = kill the entire command tree**, whether CANCEL or another reset code.
A lost control stream, TLS/HTTP2 session error, credential revocation or socket EOF
kills every command owned by that connection and closes its forwards. There is no
resume, retry, detached process survival or replay of uncertain execs. This matches
SSH remote-exec's kill-on-stdin-disconnect semantics. Bind process ownership before
I/O; handle spawn/reset races and repeated cancellation idempotently. POSIX uses a
new process group and group kill; Windows requires a kill-on-close Job Object for
all descendant branches, including children whose intermediate parent has exited.
No unwrapped spawn on wrapper failure. The helper accepts a required platform
`killTree` callback; it does not implement host spawning policy.

Use native stream backpressure in **both** directions; never collect command output
in memory awaiting exit. Bounded frame buffers and HTTP/2 flow control bound a slow
consumer. No default execution timeout: seat lifetime/cancellation is orch-owned;
bootstrap policy sets its own deadline. Release offer IDs/listeners when terminal.

## Commit-pinned seat runtime bundle

The standalone agent core (TLS connection, pairing/auth, framing and bootstrap policy)
imports **nothing from the repository or runtime bundle**. `exec-header.mjs` remains
a shared, dependency-free validator distributed with the core and with the runtime.
Do not import `seatEnvironment`, config, providers, build-gate or vcvars into the core,
and do not resolve their paths or merge their host environment on orch.

For `kind:"seat"`, orch first pushes an immutable runtime pinned to the exact full
40-lowercase-hex Git daemon commit announced in hello. The closure contains the real
`ops/orchestrator/remote-exec.mjs`, its transitive runtime imports, runtime file/script
inputs and required `node_modules` package bytes/dependencies. Include package/lock
metadata, build-gate scripts/launcher resources, jobwrap crate source and Cargo.lock,
and imported host configuration/role-policy/provider modules; import discovery alone
is insufficient for files loaded by URL/path or spawned. No unresolved imports, checkout
symlinks, missing dynamic inputs, network package installs or ambient checkout fallback.
Read source bytes from that commit tree, not a dirty checkout. Materialize dependency
bytes from its committed locks with package integrity verification; include the locks
in the manifest. Build platform-specific dependencies for the advertised host
Node version/platform/architecture, not the daemon's own platform.

Preserve the repository-relative layout inside
`~/.booharness/agent/runtime/<commit>/`, including dependency locations, so existing
relative imports and `import.meta.url` resource lookups remain unchanged. Here the
runnable `<bundle>` is `<commit>/ops/orchestrator`; the agent launches its host Node as
`node <bundle>/remote-exec.mjs`. The commit directory is the closure root, not a flat
copy of only remote-exec.mjs; flattening would break `../host-agent` and script paths.
No source rewriting or core import of that entry. The agent requires a supported host
Node matching the manifest; the bundle is executable code authorized by pinned orch.

### Manifest and transfer

`runtime` offers contain the daemon commit, total wire `size` and `manifestSha256`
(full lowercase SHA-256 of the exact manifest UTF-8 bytes). After `runtime-ready`, orch
opens `POST /v1/runtime/<id>` and sends request DATA: four-byte unsigned big-endian
manifest byte length, manifest bytes, then each file's bytes in manifest order with
no padding. The agent responds 200 only after verified publication, then emits
`runtime-staged`; neither receipt authorizes execution by itself. A failed transfer
uses a reset plus control `error`, never a partial success. One transfer at a time per
commit; concurrent offers get `busy`, and an existing verified commit is reused only
after its manifest hash matches. Disconnect deletes staging, never resumes it.

Manifest is exactly `{version:1,commit,entry,nodeVersion,platform,arch,files}`. `entry`
is exactly `ops/orchestrator/remote-exec.mjs`; commit must equal the authenticated hello
commit and offer commit. `nodeVersion` is the exact supported host Node version;
platform/arch match hello. `files` is a lexicographically path-sorted array of unique
`{path,size,sha256,mode}` regular-file records. Each digest is full lowercase SHA-256,
size is a nonnegative safe integer, and mode is `420` (0644) or `493` (0755). Empty files
are allowed. Manifest limit is 4 MiB, at most 50,000 files and 512 MiB total wire size;
individual files at most 64 MiB and paths at most 4096 UTF-8 bytes. Reject unknown or
duplicate keys, duplicate paths and trailing/missing transfer bytes.

Paths are normalized relative POSIX paths: no empty, dot or parent components, leading
slash, backslash, NUL, drive prefix, colon/alternate stream or platform-reserved names.
On case-insensitive hosts reject aliases/case collisions and trailing-dot/space names.
No symlinks, hardlinks, junctions, devices or paths outside the closure root. Producer
may materialize an internal dependency symlink as a regular file only after proving
its target is inside the packaged closure; otherwise refuse packaging.

### Verification and seat execution

Before publication the agent verifies manifest digest and schema, identity/commit,
Node/platform/arch, entry membership, path uniqueness/canonical containment, exact
file lengths and every file SHA-256. Stream into a fresh owner-only staging directory
on the runtime filesystem, create files exclusively without following links, and
check every parent is a real directory under that staging root. Hash while writing;
never execute/import staging content. No extraction shell commands or install scripts.
Flush verified files and manifest, then atomically rename to the commit directory
without replacing another published runtime. Reject any differing bytes under an
existing commit; do not silently overwrite or downgrade it.

Before **each seat launch**, verify the stored manifest digest against the accepted
offer and verify the complete manifest-listed file set, regular-file/parent types,
lengths and SHA-256 again. Reject extra executable inputs or altered bytes. Runtime
ownership/permissions prevent concurrent untrusted writes; hold the publication/use
lock through spawn and never mutate an in-use runtime. If any check fails, refuse
seat execution and require a fresh verified transfer, never a local-repo fallback.

The core validates the five-field exec header, checks its authorized cwd/host policy,
requires `runtimeCommit` to equal the current connection's daemon commit, then spawns
`node <bundle>/remote-exec.mjs` **on the agent host**. Write the unchanged legacy
four-field header (drop only kind) plus LF to relay stdin before forwarding seat stdin.
The relay performs command resolution, host env/stateDir selection, build-gate/shim
creation, jobwrap and Windows vcvars/pathPrepend/Qt existence checks on that host using
its own process environment. Orch supplies only the existing explicit extras/host
configuration, not pre-resolved daemon filesystem results. Core pipes relay stdout,
stderr and exit status and owns its process tree. Seat stdin stays open until relay
exit; early EOF and connection loss kill as in the existing SSH launcher. Missing or
invalid runtime is a named failure, not permission to execute seat work in bootstrap.

The bundle publisher/installer, policy dispatch and launcher are later-slice runtime
work; this slice defines their wire/storage contract and keeps core helpers independent.

## Reverse loopback forwarding

One `forward-open` binding belongs to a live seat on this connection. Agent binds
IPv4 `127.0.0.1` on an ephemeral port (not `0.0.0.0`, LAN, wildcard or dual-stack).
`endpointId` is an opaque identifier resolved by orch **only** to that seat's token
endpoint on orch loopback. Neither side accepts a caller-supplied host, URL or target
port. Orch must verify seat/token ownership per accepted connection; a retired seat
cannot keep access through an old ID. Bindings cannot expose MCP admin or general TCP.

For each accepted local socket, agent sends `forward-connect`. Orch verifies its
pending seat authorization and opens `POST /v1/forward/<id>`; agent matches the pending
local socket and responds 200. Response DATA carries local socket bytes to orch's token
endpoint; request DATA carries endpoint reply bytes to the local socket. END_STREAM
propagates half-close, RST closes both sockets. Use backpressure,
cap at 32 sockets per binding, and refuse excess. Session loss or `forward-close`
immediately closes the listener and active sockets; a new session needs fresh IDs and
seat authorization. The token endpoint's own authentication remains mandatory.

## Certificate rotation

Only an authenticated, currently pinned orch can send `cert-rotate`. Agent verifies
DER → fingerprint equality, persists old+pending pins and a ten-minute pending-pin
expiry atomically, then replies ready. Expiry cancels an unactivated rotation.
Orch must not activate a new certificate before every affected connected agent has
acknowledged (offline hosts need an explicit operator recovery path). Rotation does
not terminate live execs: activation uses drain/GOAWAY, then a fresh authenticated
connection may accept the acknowledged pending pin. After successful credential auth
under that certificate, atomically promote it and remove the old pin. Unacknowledged,
wrong, expired or lost pending pins never cause a PKI/TOFU fallback. A new pairing
window is the explicit recovery path if a host missed rotation. No private key crosses
the wire. `certificate` is at most 16 KiB decoded.

## Agent self-update push

After `update-ready`, orch opens `POST /v1/update/<id>` and streams the artifact as
request DATA; agent responds 200 only after staging verification succeeds. Offer is connection-bound,
one-use, `size` is 1–67,108,864 bytes and `sha256` is a full lowercase SHA-256 hex digest.
Agent streams to an owner-only temporary file on the installation filesystem, rejecting
wrong size/hash/platform/arch/version (no downgrade). Verify before staging, fsync and
atomically rename; `update-staged` is not a claim that the new version is running.
RST, disconnect, disk error or verification failure discards the temporary file, leaves
the installed binary untouched and sends `error` if control is usable. No executable
path, command or arbitrary download URL can be supplied in the offer.

`update-activate` is one-use and is refused as `busy` while commands or forwards exist.
On acceptance, use atomic local activation and restart. The next hello proves the
installed version; orch never infers success from disconnection. If the new version
does not start, restore and restart the previous verified version, remove the failed
staging directory and record the outcome; a rollback-start failure is explicit. The
restarted agent reads `update-result.json`, sends its outcome as `update-result` on
the authenticated control link once, then removes the file. No shell fallback or
unverified execution is permitted.

## Drain, close and failure

On orch drain: stop issuing offers, revoke forwards, allow current commands to finish
within the operator's drain deadline, then send GOAWAY(NO_ERROR). Orch is the HTTP/2
client, so its last accepted peer stream ID is 0 (server push is disabled); it also
stops creating new request streams. Agent's GOAWAY, if sent, names the last accepted
orch request stream ID. New exec offers/streams during drain are refused without execution. At deadline
close the connection; agent kills all still-owned trees. GOAWAY itself does not kill
accepted streams until they finish or the connection closes. Agent reconnects only as a
fresh session after the old session is terminal, never resubmits pending operations.

Unknown routes get 404 and no side effects; invalid state/frames get PROTOCOL_ERROR;
operation cancellation uses CANCEL; internal spawn/I/O failure uses INTERNAL_ERROR.
Connection-fatal protocol errors close all streams and therefore kill active trees.
No message is a durable job receipt. After any disconnect orch reports uncertain work
as interrupted, never completed or automatically retried.
