# Local memory service

See [INSTALL.md](../../INSTALL.md) for installation. The kit uses one local memoryd writer at `http://127.0.0.1:7717`. Do not start another daemon against the same database. A down service is unavailable, not permission to substitute data.

Clients resolve `MEMORYCTL_URL`, then `service.url`, then loopback. Explicit offline import requires `--db`; do not import into a database receiving live writes. Backups require a destination configured by the operator and verification before restore. No donor destination is bundled.

Frozen donor evaluation snapshots and benchmark cases are excluded. Generate fresh evaluation inputs with the shipped evaluator against your own database before scoring; old donor IDs are not your data.
