## Module registry and contracts

verified: 2026-10-22

Module contract YAML headers are the hand-kept source for ownership. `scripts/module-registry.mjs` scans module-root CONTRACT.md, `src/utils/<name>.CONTRACT.md` and `docs/contracts/modules/<id>.md`. Required fields identify the module, owner domain, path globs, tracked entry inside those paths and coverage-policy layer. `docs/architecture/CONTRACT_TEMPLATE.md` (not in this kit) defines the format; `docs/contracts/module-index.md` (not in this kit) indexes modules.

The registry writes ignored `artifacts/module-registry.json`; `--check` writes nothing. It rejects invalid/duplicate headers, unknown owner/layer, entries outside paths, overlapping membership and uncovered non-excluded tracked files in coverageClosed areas (`docs/architecture/module-coverage.json` (not in this kit)). Legacy `depends` is accepted but ignored; `--check` prints a non-failing removal warning for each header that still carries it (task 2996). NUL-delimited git paths preserve non-ASCII names. Coverage exclusions carry reasons; coverageClosed governs registry coverage while closed governs boundary gates.

`scripts/check-commit.mjs` (not in this kit) runs the registry beside the boundary ratchet with named paths: file faults are scoped, deleted paths skipped, header faults always checked. `scripts/test-module-registry.mjs` (not in this kit) and `scripts/test-check-commit.mjs` (not in this kit) cover it. `scripts/module-map-ts.mjs` (not in this kit) and `scripts/module-map-rust.mjs` (not in this kit) generate ignored maps under `artifacts/module-map/`.
