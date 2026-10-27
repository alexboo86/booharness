"""Resident BGE cross-encoder. JSONL: {id, query, docs[]} -> {id, scores[]}.

Recipe measured for task 2694: MPS float16 (CPU float32), batch 4, 512 tokens.
Device comes from RERANK_DEVICE (mps|cpu); this process never selects it.
Only --download may access the network; service/check runs use the pinned cache.
"""
import importlib.metadata
import json
import os
import sys
import time

MODEL = "BAAI/bge-reranker-v2-m3"
REVISION = "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e"
REQUIREMENTS = {"torch": "2.14.1", "transformers": "5.20.2", "sentencepiece": "0.2.2",
                "huggingface_hub": "2.2.0"}
if sys.argv[1:] == ["--requirements"]:
    print("\n".join(f"{name}=={version}" for name, version in REQUIREMENTS.items()))
    sys.exit(0)
if sys.argv[1:] not in ([], ["--download"]):
    raise SystemExit("usage: rerank-worker.py [--requirements|--download]")
for package, expected in REQUIREMENTS.items():
    actual = importlib.metadata.version(package)
    # The pytorch CPU index build is the same pin with a +cpu local tag
    # (torch 2.14.1+cpu, the only win_arm64 wheel).
    if actual != expected and actual != f"{expected}+cpu":
        raise RuntimeError(f"{package} {actual}, expected {expected}; run install:memory")

# Bound CPU work before importing numerical libraries, as in bench-reranker.py.
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["OMP_NUM_THREADS"] = "4"
os.environ["MKL_NUM_THREADS"] = "4"
started = time.perf_counter()
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer
from huggingface_hub import try_to_load_from_cache

torch.set_num_threads(4)
torch.set_num_interop_threads(1)
# Availability is not capability. The installer chooses once and writes
# RERANK_DEVICE; this process never selects or switches a device.
device = os.environ.get("RERANK_DEVICE")
if device not in ("mps", "cpu"):
    raise RuntimeError("RERANK_DEVICE must be mps or cpu")
dtype = torch.float16 if device == "mps" else torch.float32
local = sys.argv[1:] != ["--download"]
tokenizer = AutoTokenizer.from_pretrained(MODEL, revision=REVISION, local_files_only=local)
model = AutoModelForSequenceClassification.from_pretrained(
    MODEL, revision=REVISION, local_files_only=local, dtype=dtype,
    attn_implementation="sdpa").to(device).eval()
cached = try_to_load_from_cache(MODEL, "config.json", revision=REVISION)
if not isinstance(cached, str) or os.path.basename(os.path.dirname(cached)) != REVISION:
    raise RuntimeError("pinned BGE snapshot missing from model cache")
if device == "mps":
    torch.mps.synchronize()
print(json.dumps({"ready": True, "model": MODEL, "revision": REVISION,
                  "device": device, "dtype": str(dtype), "batchSize": 4,
                  "maxLength": 512, "loadSeconds": time.perf_counter() - started}), flush=True)

for line in sys.stdin:
    request_id = None
    try:
        request = json.loads(line)
        request_id = request["id"]
        if type(request_id) is not int or request_id < 1:
            raise ValueError("expected positive request id")
        docs = request["docs"]
        if not isinstance(request["query"], str) or not isinstance(docs, list) or len(docs) > 30:
            raise ValueError("expected query string and at most 30 docs")
        if any(not isinstance(doc, str) for doc in docs):
            raise ValueError("docs must be strings")
        scores = []
        for offset in range(0, len(docs), 4):
            pairs = [[request["query"], doc] for doc in docs[offset:offset + 4]]
            inputs = tokenizer(pairs, padding=True, truncation=True,
                               return_tensors="pt", max_length=512)
            inputs = {key: value.to(device) for key, value in inputs.items()}
            with torch.inference_mode():
                scores.extend(model(**inputs).logits.view(-1).float().cpu().tolist())
        print(json.dumps({"id": request_id, "scores": scores}, allow_nan=False), flush=True)
    except Exception as error:
        print(json.dumps({"id": request_id, "error": str(error)}), flush=True)
        sys.exit(1)
