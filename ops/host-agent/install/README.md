# Per-user host-agent installation

The artifact is an uncompressed ustar archive containing a `buildBundle` directory.
Every regular file and the exact file set are checked against `manifest.json` before
any bundle code runs. The service starts a stable launcher which verifies the selected
bundle again on every start. Updates arrive only as bytes on the authenticated,
certificate-pinned agent connection; there is no update URL or shell command in the
wire offer.

## macOS and Linux

```sh
./install.sh agent.tar < pairing.json
./uninstall.sh
```

`install.sh` installs a launchd user agent on macOS or a systemd user unit on Linux.
It needs no root privileges. `NODE_BIN` may name the Node executable when `node` is
not on the installer's PATH.

## Windows

```powershell
Get-Content -Raw pairing.json | ./install.ps1 -Bundle agent.tar
./uninstall.ps1
```

The PowerShell installer registers a per-user Task Scheduler task with
`InteractiveToken` and `LeastPrivilege`; it does not request administrator rights.
Windows discretionary ACL hardening is task 3529: POSIX mode bits are not treated as
an ACL substitute.

`pairing.json` is the one-line QR payload
`{version:1,address,fingerprint,secret}` shown by orch. It is written owner-only on
Unix, never placed in argv, and deleted after pairing. The credential and all versions
live under the per-user installation root. Uninstall stops and deregisters the service,
then removes that root, including any credential or unconsumed pairing secret.

A failed install or integrity check starts nothing. An update is staged beside the
current version, a detached stable switch helper atomically changes the pointer,
and a failed start restores and restarts the previous version. The helper records
activation or rollback in `update-result.json`; it does not depend on the old agent
staying alive after the supervisor stops it. The restarted agent sends that outcome
to orch over the authenticated control link once and then removes the file.
