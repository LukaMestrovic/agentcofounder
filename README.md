# AgentCofounder starter

A forkable baseline for the AgentCofounder challenge. It gives every team the same pinned Pi runtime, neutral web application seed, execution command, telemetry collector, and public contract while leaving the actual agent strategy participant-owned.

This repository installs Pi as a local dependency at exactly `@earendil-works/pi-coding-agent@0.84.1`. Do not use the floating shell installer and do not run `pi update` during the challenge.

## Repository boundary

- `solution/` is the main participant surface: change the prompt, extension, skill, or replace the runner strategy.
- `app-template/` is the neutral application seed copied into a fresh generated workspace for every run.
- `contract-public/` contains the replaceable public idea, domain-neutral journey guidance, and the result schema.
- `src/` is the baseline runner and auditable result assembly.
- `output/app/` is disposable generated application code and is reset before every run.
- `artifacts/runs/` contains Pi JSON events, session JSONL files, stderr, and the run input.

Official hidden prompts, hidden tests, model credentials, and final scoring code must remain outside participant repositories.

> **Organizer release requirement:** `contract-public/development-idea.txt` is a development placeholder. Replace it with the finalized public prompt before sharing this repository with participants. Never place hidden judging material in this file.

## Prerequisites

- Node.js 22.19 or newer within major 22. If Homebrew's `node@22` is installed, the challenge command automatically hands off from a newer active Node version.
- npm 10.9.3, matching the committed lockfiles and container image.
- Provider authentication supported by Pi, or organizer-provided provider/model environment variables.

## Setup

```bash
npm ci --ignore-scripts
npm --prefix app-template ci --ignore-scripts
npm run check
```

Provider-specific credentials are read by Pi. The optional challenge variables select the organizer's runtime configuration:

```bash
export CHALLENGE_PROVIDER="provider-name"
export CHALLENGE_MODEL="model-id"
export CHALLENGE_THINKING="off"
```

Never commit credentials. `.env.example` documents variable names, but the runner intentionally does not load `.env` files.

The default thinking level is `off` to avoid multiplying output-token cost in the efficiency ranking. Raise it only when measurements show the extra reasoning improves completion quality.

The strict Node engine is intentional. When the active shell uses Node 23+, the challenge runner looks for Homebrew's `node@22` or `CHALLENGE_NODE_BINARY`, then prepends that runtime for generated-app installation and execution. Setup commands outside the challenge runner should still use Node 22 directly.

The Docker build runs the full check suite, including short-lived Vite servers over the builder's loopback interface. The image declares port 3000 for organizer-controlled browser evaluation; publishing that port still requires an explicit container port mapping or shared container network.

## Run the public challenge

The runner uses `contract-public/development-idea.txt` by default. During template development it contains a placeholder; organizers must replace that file with the finalized public prompt before participant distribution.

```bash
npm run challenge
```

Use `--idea-file /path/to/idea.txt` to override the default for organizer testing or hidden evaluation. Give each experiment a separate output directory to preserve previous generated apps:

```bash
npm run challenge -- \
  --idea-file /absolute/path/to/idea.txt \
  --output-dir output/my-other-app

npm --prefix output/my-other-app run dev
```

Generated apps all default to port 3000, so run one preview at a time.

Each paid run has an indicative €0.25 safety target by default, plus hard per-agent model-call and output-token limits. Override it only deliberately with `CHALLENGE_EXPERIMENT_MAX_EUR`; the runner will not begin implementation if planning already consumes the target.

The runner permits at most two fresh repair sessions after independent verification. Set `CHALLENGE_MAX_REPAIRS` to `0`, `1`, or `2`; the default is `2`.

For a setup-only check that does not call a model:

```bash
npm run challenge -- --prepare-only
```

After a complete run:

```bash
cd output/app
npm run dev
```

The app must be available at `http://localhost:3000`. In another terminal, validate the machine-readable result:

```bash
npm run validate:result -- output/app/result.json
```

## Result and telemetry ownership

The runner derives `report.partial.json` from the validated schema and final verification state. It writes `result.json` after parsing every completed planner, generator, and repair event. This keeps bookkeeping out of model context and prevents the model from inventing headline token totals.

The runner first invokes a small planner with the product idea and canonical journey guidance. A typed submission tool validates and writes `output/app/app-schema.json`, a prompt-specific blueprint covering product journeys, data rules, visual direction, ordinary source files, and task ownership. The schema is coordination data, not a fixed UI renderer. A one-shot generator then writes the declared idea-specific source without reading files or running checks.

Vitest, production build, and live-server verification run outside the model context. On failure, the runner may launch up to two fresh repair sessions containing bounded diagnostics and a schema-derived write allowlist. The first repair is targeted to implicated task files; the second may inspect all declared files. Generator source-writing history is never replayed into a repair context.

Before model implementation, the runner adjusts only the copied workspace with a named/default React entry adapter and deterministic Testing Library cleanup. These domain-neutral changes avoid spending repair tokens on starter compatibility while leaving the source template untouched. Reporting is also runner-owned, so malformed model bookkeeping cannot invalidate a verified app.

`app-template/` remains an unmodified seed. Every architectural decision and source-code change happens only in its disposable copy under `output/app/`, allowing different ideas to produce different data models, interactions, file structures, and visual designs.

The runner independently executes the pinned Vitest binary, requires at least one completed passing test with no skipped or todo tests, runs `npm run build`, starts the application, probes the published `http://localhost:3000` URL only while the spawned server is alive, and terminates the full process group. Passing verification produces the specification-defined `tests_run` record; failed verification can never be promoted to success. Independent Vitest, build, and startup evidence is recorded in `harness_checks`. The runner also owns `app_url` and a location-aware `start_command`, so model formatting cannot invalidate an otherwise verified run.

The runner records whether port 3000 was occupied before Pi starts. If Pi leaves a listener behind, cleanup only targets same-user listener processes whose working directory is the generated app; Linux uses `/proc`, while macOS uses bounded, non-blocking `lsof` calls. A listener that predates Pi is never reclaimed. The `port_reclamation` result field records whether cleanup was considered, attempted, and successful, plus the affected process IDs.

A provisional result is written before app verification starts. Verification failures degrade a completed model run to `partial`; Pi startup or telemetry failures remain `failed`. Equivalent final results are emitted at the generated app root (`output/app/result.json`), repository root (`result.json`), and timestamped audit directory (`artifacts/runs/<run-id>/result.json`); only `start_command` differs so each command works from the directory containing its result. The root copy is a transient, ignored compatibility file, while the audit copy preserves each local run. Failure to write any required destination makes the harness exit non-zero. Port 3000 must be free on both IPv4 and IPv6 loopback addresses before verification begins.

The raw planner, generator, and repair event streams are retained for audit. Official judging must independently recompute usage across all of them and compare it with `result.json`; the participant-controlled report is never the final scoring authority.

`reasoning_tokens` and `cost_total` are included as additional audit fields. The command also prints the public competition score `input + 3 × output + 0.1 × cache reads`; cache writes are retained separately but are not part of that formula.

## Reference public validation

The last measured GLM 5.2 run before context-isolated verification used Berget with thinking disabled and passed the generated tests, production build, and live-server check. These numbers are a historical reference; the phase-isolated pipeline must be benchmarked separately before claiming an additional improvement.

| Metric | Frozen public baseline | Planner-guided solution | Change |
| --- | ---: | ---: | ---: |
| Model calls | 35 | 12 | -65.7% |
| Input tokens | 10,722 | 5,067 | -52.7% |
| Output tokens | 12,541 | 11,844 | -5.6% |
| Cache-read tokens | 491,008 | 129,024 | -73.7% |
| Weighted score | 97,445.8 | 53,501.4 | **-45.1%** |
| Pi-reported cost | €0.035804 | €0.028755 | -19.7% |

The planner, generator, and repairs have separate model-call, output-token, and cost limits. Every repair event is included in the same audited score. The nine development and validation attempts used while designing the earlier approach reported €0.278521 in total, well below the available €25 experiment budget.

## Develop the harness

The participant strategy deliberately separates planning, generation, verification, and repair:

- `solution/planner/` defines the compact schema-producing planner;
- `solution/orchestrator/` defines one-shot source generation behavior;
- `solution/repair/` defines bounded fresh-context repair behavior;
- `src/app-schema.ts` validates file ownership and prevents generation or repair from escaping the generated app.

Do not add a challenge idea's domain vocabulary or expected records to reusable code. The official judging idea will be different.

## Security

Pi and participant extensions execute with the permissions of the current process. The included extension rejects direct `write` and `edit` calls outside the generated app, but shell commands and symlink tricks can bypass an in-process guard. It is not a sandbox. Official evaluation must run each frozen submission in an isolated container or VM with a read-only harness mount and bounded CPU, memory, disk, time, and network access.

See `docs/organizer-checklist.md` before publishing the template or running a judged submission.
