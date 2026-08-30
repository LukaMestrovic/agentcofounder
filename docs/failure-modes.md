# Observed failure modes

Every failure recorded here was seen in a real run against Berget GLM-5.2, and every fix was
verified by a later run rather than reasoned about. Runs are named by their `run_id`; the matching
audit lives in `artifacts/runs/<run-id>/` and the record in `results/runs/<run-id>/result.json`.

The headline finding: none of these were sampling luck. Three runs on 2026-08-25 looked like a
regression to ~77,000 and one died with a single model call, and each had a specific, reproducible
cause.

## How to read a failing run

`npm run results:summarize` separates *status* from *shape*. A run that failed verification once and
was repaired is a recovery, not a regression, and the two must not be compared as if equal:

```
2026-08-30T09-20-21-290Z  success   13   41,170.0   3 attempts  2 repairs  recovered after 2 repairs
2026-08-30T09-38-26-994Z  success    4   22,066.4   1 attempt   0 repairs  clean first pass
```

Repair sessions are what inflate a score. Two successes can differ by 19,000 weighted points purely
in how many repair rounds they needed, so `status: success` alone says very little.

To diagnose one run, read the per-attempt verification artifacts in order — `attempt-00` is the
generator's own output, and anything later is post-repair:

```sh
artifacts/runs/<run-id>/verification/attempt-00/app-build.log          # tsc --noEmit and vite build
artifacts/runs/<run-id>/verification/attempt-00/app-test-results.json  # vitest JSON report
artifacts/runs/<run-id>/verification/attempt-00/app-dev.log            # dev server
```

## Harness defects

### Planner output truncation

*Seen in `2026-08-25T12-28-23-693Z`, `…13-01-53-338Z`, `…13-30-44-211Z`.*

The planner ran under `CHALLENGE_MAX_OUTPUT_TOKENS: 2400`, and its first call reported **exactly**
2400 output tokens in all three runs. The schema JSON was cut mid-write, `submit_app_schema` never
completed, and `app-schema.json` was never created:

```
Error: Could not read app schema: ENOENT ... output/main-bench-03/app-schema.json
```

The planner is allowed two model calls. `13-30-44` spent both on truncated attempts and ended at one
audited call with nothing generated. The other two recovered on the second call but planned in a
rush. A healthy planner call on this idea uses ~1,700 output tokens, so 2400 left almost no margin.

**Fixed** by raising the planner cap to 4000. **Watch for**: any first-call `output_tokens` landing
exactly on the cap — that is truncation, never a coincidence.

### Unpinned sampling

Pi sends `temperature`, `top_p`, and `seed` only when a model entry declares them, and
`~/.pi/agent/models.json` is untracked. Every run before this was therefore sampled at GLM's default
temperature of 1, which is the real reason two runs of one idea produced different file layouts and
different test counts.

**Fixed** by `solution/extensions/deterministic-sampling.ts`, which pins `temperature: 0`,
`top_p: 1`, and a fixed `seed` on every phase via `before_provider_request`.

**Caveat, and it matters**: this narrows variance, it does not remove it. vLLM and SGLang batch
requests, and float reduction order inside a batch depends on what else is in flight. Two runs with
the same seed are *close*, never identical. Do not treat a repeated score as a checksum.

### Vitest timeout masking the real error

*Seen in `2026-08-30T08-29-10-099Z`.*

`app-template/vitest.config.ts` never set `testTimeout`, so vitest's 5s default applied. The
generator writes one journey test driving the whole UI through `userEvent`, which types character by
character with a real delay per key. It expired mid-journey and reported:

```
Error: Test timed out in 5000ms.
```

This is the most expensive class of defect in the whole system, because **it corrupts the repair
brief**. The repair agent was handed a timeout instead of the assertion that actually failed, so it
had nothing to act on: repair 1 edited blindly, and repair 2 spent four model calls reading files
and never edited at all. Raising the timeout surfaced the true error, which was a one-line fix.

**Fixed** by `testTimeout: 30_000` / `hookTimeout: 30_000` in the app template. **General rule**:
repair quality is bounded by the quality of the error it receives. A check that reports the wrong
cause is worse than a check that fails loudly.

## Generated-code defects

### Enum literal unions reject `string`

*Seen in `2026-08-24T18-24-04-852Z`, which cost two repair sessions and 19,302 weighted points.*

The scaffold typed enum fields as a bare string-literal union. A `<select>`'s `onChange` hands back
`string`, so `tsc --noEmit` — which runs inside `npm run build` — rejected it:

```
src/App.tsx(86,9): error TS2322: Type 'string' is not assignable to type
  '"Novel" | "Cookbook" | "Reference" | ... | undefined'
```

Note the tests passed 8/8 on every attempt in that run. The failure was entirely in the build.

**Fixed** in `src/scaffold-data-layer.ts`: alongside each options const the scaffold now exports a
type alias and a total coercion, and the generator's context shows the exact `useState`/`onChange`
pattern.

```ts
export const bookCategoryOptions = ["novel", "cookbook"] as const;
export type BookCategory = (typeof bookCategoryOptions)[number];
export function asBookCategory(value: string): BookCategory {
  return bookCategoryOptions.includes(value as BookCategory) ? (value as BookCategory) : bookCategoryOptions[0];
}
```

## Testing Library failure modes

All four were in the model's own UI smoke test. The scaffolded `store.test.ts` passed in every run
it appeared in — generating those tests deterministically removed that entire failure surface.

Each is now a rule in `solution/orchestrator/system-prompt.md`, and the recovery for each is a rule
in `solution/repair/system-prompt.md`.

### Text broken up by multiple elements

*Seen in `2026-08-30T08-58-19-599Z`. Survived both repair sessions.*

```jsx
<strong>{lentTotal}</strong> lent out      // renders "0 lent out" visually
```
```
Unable to find an element with the text: 0 lent out.
This could be because the text is broken up by multiple elements.
```

Testing Library's `getNodeText` joins only an element's **direct text-node children**, so that `<p>`
reads as `" lent out"` — the `0` lives in a child element and is invisible to the query. This is why
repair's attempt to widen the query to `/0.*lent/i` also failed: **no regex can fix it**, because
the string being matched never contains the number.

**Rule**: render a count and its label in one text node — `` <p>{`${lentTotal} lent out`}</p> ``.
This is a component defect, not a query defect.

### Accessible name on the wrong element

*Seen in `2026-08-30T09-10-13-785Z`. Survived both repair sessions.*

```jsx
<section className="book-list" aria-label="Book collection">   // role="region"
  <ul className="book-cards">                                   // role="list", unnamed
```
```
Unable to find an accessible element with the role "list" and name "Book collection"
```

The name was present in the file, just on the wrong node — which is likely why repair searched,
found the string, and concluded nothing was wrong. A `<section aria-label>` is a `region`, not a
`list`.

**Rule**: put the accessible name on the element that actually carries the queried role.

### Per-row controls are ambiguous

*Seen in `2026-08-30T09-20-21-290Z`.*

```
Found multiple elements with the role "button" and name "Lend"
```

Two books, each with a Lend button. Repair's first attempt scoped with
`getByRole("listitem", { name: "Book Two" })` and failed differently:

```
Unable to find an accessible element with the role "listitem" and name "Book Two"
```

Both the generator and the repair agent assumed a row's text content names it. **It does not.**
`button`, `link`, and `heading` take their accessible name from content; `listitem`, `list`, and
`region` are named only by an explicit `aria-label`.

**Rule**: give every list row `aria-label={<row identifier>}` and scope per-row controls with
`within(screen.getByRole("listitem", { name: … }))`. Both halves are required — scoping without the
label fails, and the label without scoping stays ambiguous.

### Bare role query with no name

*Seen in `2026-08-30T10-14-55-486Z`. Survived both repair sessions; the run ended `partial`.*

```
Found multiple elements with the role "textbox"
  <input aria-label="Book title"  type="text" />
  <input aria-label="Book author" type="text" />
```

The component was **correct** — both inputs carried a unique `aria-label`. The test queried the bare
role. Any form with two text fields breaks `getByRole("textbox")`.

Worse, the error message printed both real `aria-label` values, and repair still invented a
different name, converting the failure into `Unable to find an accessible element with the role
"textbox"` on both remaining attempts. An overcorrection like this is strictly worse than the
original error, and it consumed the entire repair budget.

**Rules**: never query a repeatable role without `{ name }` (orchestrator); when the error lists
candidate elements, reuse one of the printed `aria-label` strings verbatim (repair).

### Stale element reference after a re-render

*Seen in `2026-08-30T09-10-13-785Z`, behind the accessible-name bug.*

```jsx
const list = screen.getByRole("list", { name: "Book collection" });
// … filter changes, the <ul> unmounts and remounts …
expect(within(list).getByText("Dune")).toBeInTheDocument();  // element could not be found
```

**Rule**: never reuse an element captured before a re-render; re-query inside
`within(screen.getByRole(…))` at each assertion.

## Operational notes

### `.env` is not loaded by the runner

`CHALLENGE_PROVIDER` and `CHALLENGE_MODEL` live in `.env`, which `src/run-challenge.ts` never reads.
Running without sourcing it falls back to Pi's default model and dies with `No API key found for the
selected model` at zero model calls and zero cost. Source it first:

```sh
set -a; . ./.env; set +a
npm run challenge -- --output-dir output/run-01
```

Such a run still writes a `results/runs/<run-id>/result.json` with `model_calls: 0` and
`weighted_score: 0`. That is an environment error, not a run; do not commit it to the canonical
store.

### Runs cannot be parallelised

Verification binds port 3000 with `--strictPort` and requires it free on both IPv4 and IPv6 loopback
before starting. Batch runs must be sequential, each with a fresh `--output-dir`. Never seed one
generated app from another.

### Harmless log noise

These appear in `app-dev.log` on a failing run and are symptoms, not causes — they mean an earlier
build or parse step already failed:

```
(!) Failed to run dependency scan. Skipping dependency pre-bundling.
[vite] (client) Pre-transform error: The service is no longer running: write EPIPE
```

### The repo's own suite has environment-dependent failures

`test/verify-app.test.ts` and one case in `test/run-challenge.test.ts` time out at 45s under WSL2 —
they run real npm builds and start real servers. The count varies between runs on an unchanged tree,
so confirm against the pre-change commit before attributing them to an edit. `test/result.test.ts`
and `test/scaffold-data-layer.test.ts` are deterministic and should always pass.

## The "broken up by multiple elements" hint is boilerplate

Testing Library appends

```
This could be because the text is broken up by multiple elements.
```

to **every** failed `getByText`, whether or not that is the cause. In `2026-08-30T10-27-56-967Z` the
markup was `<span className="lent-badge">Lent to {book.borrower}</span>`, which normalises to
exactly the queried string and would have matched. Repair fixed that run by changing the query, and
the component was never touched — so the hint pointed at the wrong layer.

Treat the hint as one hypothesis, not a diagnosis. Confirm it by checking whether the value is
actually wrapped in its own child element before rewriting any markup.

## Reproducibility, measured

Six runs on the public book-shelf idea with the fixes in place, pinned sampling, sequential
execution, a fresh output directory each time:

| Run | Status | Calls | Score | Shape | Prompt wording |
| --- | --- | ---: | ---: | --- | --- |
| `…09-38-26-994Z` | success | 4 | 22,066.4 | clean first pass | idea-flavoured |
| `…09-48-33-789Z` | success | 5 | 30,695.0 | clean first pass | idea-flavoured |
| `…09-58-37-254Z` | success | 4 | 25,031.4 | clean first pass | idea-flavoured |
| `…10-06-45-923Z` | success | 4 | 24,900.6 | clean first pass | neutral |
| `…10-14-55-486Z` | partial | 14 | 50,834.0 | 2 repairs, never passed | neutral |
| `…10-27-56-967Z` | success | 14 | 47,290.4 | recovered after 2 repairs | neutral |

Five of six succeeded; four of six were clean first passes. A clean pass costs 4-5 model calls and
lands at 22,000-31,000. Any run needing repair roughly doubles that, so **the clean-pass rate, not
the success rate, is what determines the score.**

Two cautions on reading this table. The spread across clean passes alone is 22,066 to 30,695 — 39%
— at temperature 0 with an identical seed, which is the batching non-determinism described above.
And the two failures both fall in the neutral-wording group, so the effect of removing
idea-flavoured examples from the prompt is **not established either way**: three neutral runs
against three flavoured ones cannot separate a real regression from noise. Do not claim the
genericisation was free without more runs.
