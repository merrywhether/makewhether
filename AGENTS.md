# makewhether

makewhether runs agent work as statecharts. One engine runs the machines,
workers report outcomes, and a person can answer through the same task workflow.
The first milestone focuses on the core engine with fake workers.

## Setup and checks

Run these commands from the repository root before committing.

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm lint
mise exec -- pnpm typecheck
mise exec -- pnpm test
```

Lint treats warnings as errors. CI runs lint and typecheck. Run `pnpm test`
locally.

## Packages

`.package-graph.cjs` defines allowed dependencies. Lint checks both workspace
manifests and source imports. The scaffold declares the package layout.
[M1 (PR #1)](https://github.com/merrywhether/makewhether/pull/1) provides the
implementations described below.

- **`domain`** owns shared types and Effect schemas.
- **`machines`** owns the workspace, unit, and task statecharts and the worker
  interface.
- **`store`** owns SQLite checkpoints, audit entries, and consumed inbox keys.
- **`config`** owns settings validation for routes, tiers, and limits.
- **`runner`** owns worker processes and run records.
- **`host`** runs the engine and owns the lock, inbox, live read API, and
  offline replay and check modes.
- **`cli`** implements `makew`, including engine lifecycle, inbox writes, and
  HTTP reads.

## Conventions

- Use `undefined` for absence. Lint allows `== null` and `!= null` checks
  anywhere. Use these comparisons at external boundaries.
- Decode external input with the owning schema. Use `domain` for shared
  contracts.
- Use scoped Conventional Commits, such as `docs(repo): add review guidance`.
- Review changes using [.agents/review.md](.agents/review.md).
