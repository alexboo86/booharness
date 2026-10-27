# The ladder — how a change is sized before it is written

The contract carries the seven rungs; this file carries what they mean, what they
do NOT mean, and where the idea came from.

## The rungs

Before writing code, stop at the first rung that holds:

1. **Does this need to exist?** → no: do not build it.
2. **Already in this codebase?** → reuse it, do not rewrite it.
3. **Standard library?** → use it.
4. **Native platform feature?** → use it.
5. **A dependency already installed?** → use it.
6. **One line?** → one line.
7. Only then: the minimum that works.

## Lazy about the SOLUTION, never about READING

The ladder runs AFTER you understand the problem, not instead of it: read the
code the change touches and trace the real flow first. This is the same rule the
contract already states for code intelligence — `probe`/`ast-grep` before `grep`,
and a search you read and judge yourself instead of a call graph that does not
exist.

A rung chosen without reading is not laziness, it is a guess.

## Lazy, not negligent

Never on the chopping block, whatever the rung:

- validation at a trust boundary;
- data integrity — the contract's own inviolable rule;
- error handling that prevents loss;
- security;
- the project's UI rules for anything the operator looks at.

Minimal is not unfinished. A change that drops one of these is not a smaller
change, it is a broken one.

## Why this does not contradict "no fallbacks, no patches"

The operator's standing rule is «никаких фолбеков, никаких заплаток, только
чёткие фундаментальные решения». Read together with the ladder they say the same
thing from two sides:

- a PATCH adds a layer beside the cause;
- a ROOT fix removes the cause, and is almost always the SMALLER of the two.

The ladder forbids extra machinery, never completeness. When the remedy genuinely
is a new layer, a new abstraction or a new gate, say what it buys — the operator
pays for it in tokens, in review rounds and in everything that has to keep
working afterwards.

## Deferred simplification is a MARKER, not a memory

When a rung is skipped on purpose, leave the reason where the code is:

```
// debt: <what was skipped and why>
```

and open a `memoryctl task` in the same breath. A marker without a task is a
comment nobody will read again; a task without a marker sends the next reader
hunting. "Later" is otherwise "never".

## Where this came from

The rungs are adapted from [ponytail](https://github.com/DietrichGebert/ponytail)
(MIT), a skill whose whole thesis is that the best code is the code you never
wrote. Nothing of it is installed here — this harness already has its own
delivery for rules, and one more prompt-injection layer would be exactly the
extra machinery the ladder forbids.

Their measurement, and its honest limits: on a real FastAPI + React repository,
twelve feature tasks against the same agent without the skill, they report −54%
lines, −22% tokens, −20% cost, −27% time, with the safety tier unchanged. They
also state that the earlier headline of 80–94% was an artefact of comparing
against a bare conversational model, and that on a verbose reasoning model the
token and latency savings can invert. Our seats are exactly such models, so the
line count is the part expected to transfer here; the cost figure is not ours
until measured.

The ladder shrinks what an agent BUILDS, not just what it SAYS.
The caveman plugin is no longer managed here (operator decision 15303).
