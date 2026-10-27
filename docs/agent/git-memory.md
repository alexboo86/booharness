# Git and memory

Contracts, skills and hooks live in Git. Memory databases and secrets do not. Configure your own remotes; the kit does not auto-push or exempt any remote from PUSH_ACK. Run `npm run check:push` before publishing.

Memory uses the local service described in [memory.md](memory.md). Keep one writer, and use an explicit database path for offline import. Never run an importer against a database receiving live service writes.
