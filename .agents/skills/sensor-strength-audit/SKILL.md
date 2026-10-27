---
name: sensor-strength-audit
description: Judge a check or sensor by the targeted mutants it kills, not by coverage. Use when adding or reviewing a script check, gate or sensor, when a guard claims to catch a defect class, or when coverage is offered as proof of test strength.
---

# Sensor-strength audit

Coverage measures execution, not detection: a suite can execute every line and
still kill almost no mutants — 100% coverage with a 4% mutation score is the
measured example (2506.02954). A sensor is only as strong as the mutants it
kills, and the mutants must target your concern (2501.12862).

## Steps

1. Wire the sensor first: it must FAIL on a real defect of its class before it
   passes on the fix — red before green.
2. Hand-write targeted mutants, one concern per mutant — minimal edits the
   sensor claims to catch: inverted comparison, dropped boundary condition,
   swallowed error, off-by-one, removed await, inverted flag.
3. Run the mutant set against the sensor. Record killed vs surviving.
4. Every surviving mutant is a sensor gap: fix the sensor, narrow its claim, or
   record the gap as uncaught.
5. Report killed and surviving counts with the mutant list. Coverage percent is
   context, never the result.

## Verification

The mutant log: each mutant's diff, whether the sensor failed on it, and the
disposition of every survivor.

## Failure modes

- Mutants that duplicate each other or probe the wrong concern.
- A sensor green over a corpus it never read — prove the corpus is read.
- Declaring strength from coverage or from the sensor passing on clean input.
