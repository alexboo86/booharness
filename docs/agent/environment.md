# Portable environment

Paths are resolved from the target HOME and checkout. Configure remotes and SSH aliases yourself; no donor remote is trusted and commits are never pushed automatically. Memory has one local writer. See [INSTALL.md](../../INSTALL.md) and [memory.md](memory.md).

Use RTK for commands it supports; do not use proxy/run as output filters. Each agent works in its own worktree. Verify before merging or publishing with operator approval.
