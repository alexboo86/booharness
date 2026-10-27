#!/usr/bin/env python
"""Rerank basic-memory candidates with a multilingual cross-encoder.
argv[1]: query.  argv[2]: top-K.  argv[3:]: one or more JSON files (basic-memory search responses).
Multiple files are UNIONed by file_path (so hybrid∪FTS candidate pools both reach the reranker —
some notes embed poorly but match by keyword, and vice-versa).
stdout: reranked "score\tfile_path" lines, best first.
Cross-encoder reads (query, doc_text) pairs → precise relevance, fixing the bi-encoder's weak discrimination.
"""
import sys, json
from fastembed.rerank.cross_encoder import TextCrossEncoder

query = sys.argv[1] if len(sys.argv) > 1 else ""
topk = int(sys.argv[2]) if len(sys.argv) > 2 else 5
files = sys.argv[3:] or ["-"]

by_path = {}
for fp in files:
    try:
        raw = sys.stdin.read() if fp == "-" else open(fp, encoding="utf-8").read()
        data = json.loads(raw)
    except Exception:
        continue
    for r in data.get("results", []):
        p = r.get("file_path", "")
        if not p:
            continue
        txt = (r.get("content") or r.get("matched_chunk") or r.get("title") or "")[:1200]
        # keep the richest text seen for this path
        if p not in by_path or len(txt) > len(by_path[p]):
            by_path[p] = txt
if not by_path:
    sys.exit(0)
paths = list(by_path.keys())
docs = [by_path[p] for p in paths]
ce = TextCrossEncoder(model_name="jinaai/jina-reranker-v2-base-multilingual")
scores = list(ce.rerank(query, docs))
for s, p in sorted(zip(scores, paths), key=lambda x: x[0], reverse=True)[:topk]:
    print(f"{s:.4f}\t{p}")
