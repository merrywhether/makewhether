# Reviewing makewhether

Read [AGENTS.md](../AGENTS.md) before reviewing a change.

## Architecture

Review architecture before correctness. Be strict about boundaries. Blurring a
boundary makes each later change propagate through more of the codebase.

- **Keep concerns behind their package interfaces.** Import production libraries
  through their declared exports. Use executable entry points to run
  subprocesses. Tests may import fixtures by relative path from another
  package's `test/` directory. The M1 host tests use this exception for machine
  scenarios.
- **Enforce dependency direction.** Check changes against `.package-graph.cjs`
  and explain any change to the graph in the PR. Keep direct infrastructure
  access out of `domain` and `machines`. Transitions describe policy, and clocks
  and external work come through declared Effects.
- **Define interfaces before implementations.** Introduce a new capability
  through a typed interface in the package that owns it. The real implementation
  and its test fake satisfy the same contract.
- **Keep components loosely coupled.** Machines describe work through events and
  outcomes. The host connects implementations through narrow, typed interfaces,
  such as the `Workers` service. A worker can change how it runs a process
  without knowing which machine state invoked it.
- **Decode at the boundary.** Use the owning schema at ingestion. Put shared
  contracts in `domain` and keep settings or adapter-specific schemas in the
  package that owns them.
- **Give each concept one owner.** Reuse defaults, identity checks, key formats,
  and routing rules.
- **Count the cascade.** Ask which packages would need to change if the concept
  changed again. When a change would propagate into unrelated packages, identify
  the misplaced boundary or interface.
- **Use domain names.** Name units, tasks, holds, runs, and workers directly.
  Keep mechanism words such as `manager` and `util` out of exported names.

## Correctness and tests

- Test decisions with controlled time and scripted workers. Use real process,
  SQLite, and HTTP tests where lifecycle, durability, or wiring is the contract.
- Pair failure and success cases. For a core regression, temporarily break the
  guarded behavior and check that the test fails for the intended reason. Record
  the mutations in the review.
- Check that changes preserve the order and ownership of work across retries,
  holds, and restarts.

## Review findings

Focus on behavior and architecture. Let Biome and dependency-cruiser report
formatting and mechanical violations. Review changes to those checks for lost
coverage. Use the milestone report when available to identify accepted
limitations. Flag changes that expand a known recovery gap or remove its
regression coverage.
