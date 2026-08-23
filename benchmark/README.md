# Generality benchmark

These synthetic ideas exercise different product structures without entering runtime prompts or reusable solution code. Compare two frozen commits in separate worktrees with the same provider, model, thinking level, and idea file.

Run every idea three times per commit, always using a fresh output directory. The runner preserves each report locally at `artifacts/runs/<run-id>/result.json`; the root `result.json` is only the latest compatibility copy. Copy representative reports into a named folder under `benchmark/results/` when they should be reviewed and versioned in GitHub. Do not use one generated app as the seed for another.

For every result, calculate:

```text
weighted score = input_tokens + 3 * output_tokens + 0.1 * cache_read_tokens
```

Accept the refactor when all six idea groups retain their prior success rate, the paired median weighted score improves by at least 25%, median cache reads improve by at least 70%, and successful first-pass runs contain no `repair-*.events.jsonl` artifacts.

Domain terms in this directory are test inputs only. They must not be copied into `src/`, `solution/`, or `app-template/`.
