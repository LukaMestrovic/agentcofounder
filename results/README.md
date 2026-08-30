# Local run results

Every challenge execution has one canonical result at:

```text
results/runs/<run-id>/result.json
```

The JSON records the same timestamp-shaped `run_id` and runner-owned `weighted_score`. The matching raw prompts, model events, verification logs, and repair logs live under `artifacts/runs/<run-id>/`.

This is the designated persistent result store and is intentionally visible to Git for review. Do not commit a private evaluation result unless it is explicitly approved. Benchmark indexes under `benchmark/results/` link to records here instead of keeping duplicate JSON copies.
