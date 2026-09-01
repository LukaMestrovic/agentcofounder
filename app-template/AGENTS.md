# Generated application contract

- Keep the application self-contained and runnable with `npm run dev` at `http://localhost:3000`.
- Store durable single-user browser data locally when persistence is required.
- Prefer semantic HTML and accessible names so browser automation can use the interface without brittle selectors.
- Add tests for the product's critical user journeys and run them before claiming success.
- The seed intentionally contains no product tests. Add at least one completed, passing `src/**/*.test.ts` or `src/**/*.test.tsx` test; the runner rejects zero-test reports and any skipped or todo tests.
- Use only the dependencies already installed from the committed lockfile. Do not add packages or run dependency-install commands.
- `report.partial.json` contains only `status`, `app_url`, `start_command`, `summary`, `implemented_features`, `assumptions`, and `tests_run`.
- A `success` report must contain at least one `tests_run` entry and every entry must be `passed`. If a journey failed or was not run, record it as `failed`, explain why in `journey`, and use `partial` (or `failed` when the app cannot run).
- The runner owns the final `app_url`, location-aware `start_command`, independent `harness_checks`, and telemetry fields. Your product-journey test records remain in the specification-defined `tests_run` field.
- Do not create or edit `result.json`; the outer challenge runner derives its telemetry from Pi.

## Visual design system (`src/design-system.css`)

Imported automatically before `styles.css`; not writable. Compose these instead of writing equivalent
CSS — do not redeclare colors, buttons, tiles, badges, or form fields; `styles.css` holds only
page-specific layout. Dark mode is automatic via `prefers-color-scheme`; no code needed.

- A summary/stat row is a `.tile-grid` of `.tile`, not bespoke markup:
  `<div className="tile-grid"><div className="tile"><p className="text-label">Total</p><strong>{count}</strong></div></div>`.
- A list of records is a `.stack` of `.card` items, not a bespoke list/card class; put per-row actions
  in a nested `.cluster`.
- `.card` — padded panel. `.empty-state` — dashed placeholder for an empty collection.
- `.btn` (primary) / `.btn-secondary` / `.btn-danger` / `.btn-ghost`, `.btn-sm` modifier.
- `.badge` (neutral) / `.badge-info` / `.badge-success` / `.badge-warning` / `.badge-danger` for
  categories or statuses.
- `.text-label` (small uppercase eyebrow) / `.text-muted` / `.text-success` / `.text-warning` /
  `.text-danger`.
- `.field` wraps a label + input/select/textarea + optional `<p class="field-hint">`; controls inside
  are already styled.
- `.stack` / `.cluster` for any other vertical/wrapping-horizontal layout (`--stack-gap` /
  `--cluster-gap` to override spacing per instance).
- Tokens: `--color-primary`, `--color-surface`, `--color-border`, `--color-text`, `--color-text-muted`,
  `--space-1`..`--space-6`, `--radius-sm/md/lg`. For a distinctive visual direction, override only the
  token values you need (e.g. `:root { --color-primary: ...; }`) in `styles.css` instead of rebuilding
  components.
