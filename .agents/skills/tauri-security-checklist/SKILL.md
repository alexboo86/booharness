---
name: tauri-security-checklist
description: The review lens for a Tauri desktop app's attack surface — capability and permission minimality, filesystem and shell scopes, the CSP, what a command exposes to any page the webview can be made to load, IPC argument validation, secret handling, and updater signing. Use this whenever you add or widen a capability, add a Tauri command, touch a scope or an allowlist, change the CSP, wire a sidecar, handle a token or credential in the desktop app, or review a project whose manifest declares this framework. Reach for it in particular when a change makes something "just work" — in this layer, convenience is usually a widened scope.
---

# Tauri security review

A Tauri app is a native process that hands part of itself to a webview. Every
capability you grant is granted to *whatever that webview ends up running*, and
the webview runs content that is easier to influence than native code. This
checklist is the review lens; for the v2 API consult the framework's live upstream documentation (this file deliberately carries no API surface that
could go stale).

## The governing question

For every permission, ask: **if an attacker controlled the page, what would this
give them?** Not "what does the feature need" — the feature's need is the reason
the permission exists, and it is already accounted for. The review question is
about the blast radius.

## 1. Capabilities and permissions: minimal by window, not by app

- A capability grants a permission set to **specific windows**. Granting to all
  windows because there is currently only one is a decision that silently widens
  the day a second window appears.
- Prefer the narrowest permission that works. `fs:default` and a scoped
  `fs:allow-read-text-file` on one directory are different risks.
- **Every widening is a review item.** A diff that adds a permission needs a
  sentence saying what needs it and why the narrower one did not do.
- Remove permissions that a removed feature used. Dead capability is live attack
  surface.

## 2. Scopes are the real control

A permission without a scope is usually the whole class.

- **Filesystem:** scope to the directories the feature genuinely uses. Watch for
  scope patterns with `**` that reach the user's home, and for a scope that
  allows the app's own config or the updater's staging directory — write access
  there is a persistence primitive.
- **Shell:** an open `shell:allow-execute` is remote code execution by
  construction. If a sidecar is needed, allow *that binary* with a fixed argument
  shape, never a free-form command.
- **HTTP:** scope the origins. An unscoped HTTP permission turns the app into a
  proxy that speaks from the user's machine, past whatever network controls the
  page itself would have faced.
- Deny rules are evaluated with allow rules — write the deny for the sensitive
  path explicitly rather than assuming the allow pattern misses it.

## 3. Commands are an API to untrusted callers

Treat every `#[tauri::command]` as a public endpoint.

- **Validate every argument.** A path argument is the classic one: canonicalise
  it and prove it is inside the intended root; do not check with `starts_with` on
  the raw string, which `..` defeats and which a different spelling of the same
  directory defeats too.
- **Do not accept a command that names its own privilege** — a `run(cmd)`,
  `read(path)` or `fetch(url)` where the caller picks the target is the scope
  boundary handed to the caller.
- **Do not return secrets to the frontend** because it is convenient. A token in
  the renderer is a token in the DOM, in a devtools session, and in any error
  report that serialises state.
- Errors returned to the frontend should not carry filesystem paths, config
  contents or upstream error bodies.

## 4. Content Security Policy

- Set one. A Tauri app with no CSP will run whatever gets injected.
- No `unsafe-inline` and no `unsafe-eval` in production. If the build needs them,
  that is a build problem to fix, not a policy to relax.
- Restrict `connect-src` to the origins the app actually talks to. This is the
  control that turns a rendering bug into a nuisance rather than an exfiltration.
- `img-src`/`media-src` for remote content are a fingerprinting and beacon
  channel; scope them like everything else.

## 5. What the webview may load

- Never navigate a privileged window to remote content. If remote content must be
  shown, it belongs in a window with no capabilities.
- Links from data — a news item, a ticket, a user-submitted report — must open in
  the **system browser**, not in the app's webview.
- External content in an iframe still inherits the page's ability to talk to the
  command layer if the bridge is reachable; treat "we only embed X" as a claim
  that needs checking.

## 6. Secrets and credentials

- Credentials belong in the OS keychain or in a file the app owns with restricted
  permissions — not in `localStorage`, not in the config the app also serves to
  the frontend, not in an env var that a sidecar inherits.
- A secret that must reach a sidecar goes over stdin or a file descriptor, never
  on the command line: argv is world-readable on the machine.
- Redact secrets in logs and in crash/bug reports. If the adopted app collects diagnostics, whatever it collects is what leaves the user's
  machine.

## 7. Updater and signing

The updater is the highest-value target in the whole product: it installs code.

- **Signature verification must be on**, and the public key in the config must be
  the one whose private half is not on any developer machine that also runs
  arbitrary code.
- The update feed must be HTTPS with certificate validation, no fallback.
- Platform signing is part of it: an unsigned or ad-hoc-signed macOS build is
  both a user-facing gate and a supply-chain signal. Verify the adopted project's signing and updater path on every supported platform; another project's validation is not evidence.
- Never point a release build at a staging feed, and never leave a "skip
  signature" flag reachable in a release configuration.

## 8. Sidecars and resources

- A sidecar inherits the app's environment. Audit what that includes.
- Bundled resources are inputs: a resource path built from a runtime value is a
  traversal waiting to happen.
- Verify checksums of anything downloaded at runtime and executed.

## Review checklist

- [ ] every added permission is the narrowest that works, granted per window
- [ ] every scope is bounded; no `**` reaching home, config or updater staging
- [ ] no unscoped shell execute; sidecars named with a fixed argument shape
- [ ] every command validates its arguments; paths canonicalised and contained
- [ ] no command lets the caller choose its own target (path/url/command)
- [ ] CSP present, no `unsafe-inline`/`unsafe-eval`, `connect-src` scoped
- [ ] remote content never in a privileged window; data links open externally
- [ ] no secrets in the renderer, in argv, or in collected diagnostics
- [ ] updater signature verification on, feed HTTPS, keys not co-located with CI
- [ ] permissions removed along with the features that needed them

Anything asserted here about "it is confined" is exactly the kind of claim this
project's contract says to send to review rather than to self-verify.
