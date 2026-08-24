# Book shelf tracker runs

These are the previously root-level result files for the book shelf tracker prompt, plus later runs. They are preserved verbatim apart from stable, space-free filenames so the progression can be reviewed in GitHub.

| File | Captured locally | Status | Model calls | Weighted score | Cost |
| --- | --- | --- | ---: | ---: | ---: |
| `result-02.json` | 2026-08-21 08:16 CEST | success | 17 | 45,688.4 | €0.021953 |
| `result-03.json` | 2026-08-23 13:48 CEST | failed | 28 | 111,946.4 | €0.066274 |
| `result-04.json` | 2026-08-23 14:00 CEST | failed | 23 | 71,302.6 | €0.032206 |
| `result-05.json` | 2026-08-23 14:17 CEST | partial | 24 | 76,672.8 | €0.034299 |
| `result-06.json` | 2026-08-23 14:31 CEST | success | 28 | 92,515.6 | €0.041459 |
| `result-07.json` | 2026-08-23 14:42 CEST | success | 12 | 53,501.4 | €0.028755 |
| `result-08.json` | 2026-08-24 12:50 CEST | success | 4 | 29,700.2 | not reported |

The weighted score is `input_tokens + 3 * output_tokens + 0.1 * cache_read_tokens`.

`result-08.json` is the first run made after `--thinking off` was found not to reach Berget. It is the
first run whose generated application passed independent verification on the first attempt, so it
contains no repair phase at all.
