---
name: llm-grounding-audit
description: Audit LLM-produced numbers and classifications before trusting them. Use when AI/MCP or news work has an LLM state numeric facts (BriefV2 digests, MCP answers) or classify news (sentiment/impact labels), and before any sentiment or event-impact claim.
---

# LLM grounding audit

Measure what the model invents before you let it near a decision. Trust rule (memory #11973): a paper without code or our own reproduction is at most WATCH; code alone makes it an ADOPT-CANDIDATE, and nothing here is the basis of a decision until we measure it ourselves.

## Grounded numbers (BriefV2, MCP answers)

- Extract every numeric claim from the generated text and pair each with its source fact; score supported vs unsupported.
- Measure **unsupported numeric claims** and **clean-fact false positives** (a checker flagging a correct number) as two separate metrics — a checker tuned to catch hallucinations also flags true facts (FinVerBench, arXiv 2605.29586, no verified code — WATCH).
- Apply to BriefV2 generation (`<project-specific>/src/worldmonitor/brief/**`) and answers served through MCP `get_news_context` / `get_ai_digest`: audit the brief against the assembled facts, not against the market.
- Report rounding sensitivity separately from invention; a value that differs only by rounding is not a hallucination.

## News classification (DeepSeek classifier)

- Evaluate the classifier on a labelled benchmark before trusting its labels: FinBen/PIXIU (arXiv 2402.12659, code github.com/The-FinAI/PIXIU — ADOPT-CANDIDATE, not rerun by us).
- Baselines for news labels exist in FinGPT (arXiv 2306.06031) — label baselines only, never price claims.
- Target: the DeepSeek news classifier (`<project-specific>/src/classifier_worker.rs`) and semantics grouping (`<project-specific>/src/news_semantics.rs`).

## Sentiment / impact claims

- Before claiming any sentiment or event impact on price, run a **timestamp-safe walk-forward**: fit on earlier data, score on later data, no feature computed from information after the prediction timestamp.
- ETP/equity findings and address-fraud anomaly papers are not crypto spot validation; treat them as WATCH at most (arXiv 2608.09576, 2607.13916, 2605.29526 — none reproduced).

No sentiment/impact statement ships without the walk-forward numbers attached.
