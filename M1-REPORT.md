# M1 implementation report

## 1. Workspace scaffold (`b69b33e`)

- [x] Mise pins the runtime, and pnpm, Moon, TypeScript, Biome, and Vitest run
      the package checks.
- [x] Lint rejects `null` values and types. It permits `== null` and `!= null`
      as external-boundary comparisons.
- [x] Dependency checking rejects imports outside the package graph, including
      type-only imports. The pure packages also reject Node built-ins.

Mutation checks covered a forbidden dependency, a `null` value or type, and a
hidden `null` argument inside an allowed boundary comparison.

## 2. Machines and scripted workers (`19b2296`)

- [x] Task retries have a per-task budget. Holds, live reattachment, and
      finished-run replay preserve the budget. Worker verdicts follow outcome
      routing.
- [x] Generated paths reach every unit state. Active states have a progressing
      successor, and intervention escalation and caps hold across the generated
      paths.
- [x] The virtual-time scenario covers quota parking and session resume,
      model-specific fallback, judge rework, dependency release, round limits,
      and a person answering after a reminder.
- [x] Only the selected person worker can cancel. Cancellation cascades through
      pending dependents, including those added later, and retains the
      dependency that caused it.

Mutation checks covered the retry limit and session, hold scope and hard versus
soft behavior, worker selection after a park, intervention cap and escalation,
default `unsure` routing, decision phase selection, limit increases, stale
person answers, cancellation authority and cascade, and manual hold-timer
cancellation.

## 3. Persistent engine (`7d44609`)

- [x] The crash sweep restored each of the 26 distinct checkpoints captured by
      the baseline at 0 seconds, 45 seconds, and 4 hours of virtual downtime. It
      checked final outcomes and that completed worker runs were never started
      again.
- [x] Separate crash injections cover an inbox event applied before
      checkpointing and a worker finishing before the engine receives its
      result. The sweep covers runs and holds already in the checkpoint.
- [x] A root migration restores an older checkpoint and continues. Boot refuses
      a tree containing an errored machine and identifies the failing path.
- [x] Boot drains a queued hard pause before opening the fresh-worker gate. One
      engine owns a data folder at a time, including across path aliases and
      after `SIGKILL`.
- [x] The inbox ignores temporary files, consumes each key once, and archives
      invalid or rejected commands. Checkpoint, audit entries, and consumption
      share a SQLite transaction.
- [x] `runner.started` audit entries retain the resolved tier, harness, model,
      account, effort, and time limit. `makew send` validates positional or
      piped JSON before writing an inbox file.

Mutation checks covered atomic persistence, duplicate and partial inbox input,
rejection archives, the executable boot gate, incomplete child progress in a
consumed-key checkpoint, version validation, audit fields, stale PID identity,
lock aliases, and checkpoint coalescing.

## 4. Process-backed run records (`a760a78`)

- [x] One real-engine test kills the engine twice. The quota hold lifts within
      one second of its saved deadline, and the answer queued during the second
      downtime reaches the waiting person task. No key starts twice and no
      worker is left behind.
- [x] Limits and errors retain the raw JSONL line and record path in
      `evidence.jsonl`.
- [x] A live PID with another start time is treated as stale. A dead unfinished
      run consumes one attempt, and its retry uses the original session with a
      new key.
- [x] A clean engine stop leaves live work available for reattachment to the
      same PID. A delayed wrapper observes a park marker before starting its
      harness.

Mutation checks covered duplicate run claims, boot gates, lost session IDs, lost
versus deliberately parked runs, orphaned harnesses, clean shutdown, stale
process identity, zombie classification, raw evidence, and host clock selection.

## 5. CLI checks

- [x] `makew replay <recording>` uses resolved inbox commands and timed worker
      records from an isolated copy. It reproduced the outcomes and exact start
      and answer times of a relocated recording after the original folder was
      removed. A recorded worker loss also replayed through its
      session-preserving retry.
- [x] `makew unit ls` and `makew unit show <id>` read current tasks, unmet
      dependencies, and holds from the loopback engine. The list omits finished
      units, and both reads omit passed dependencies. The three-unit scenario
      checks that every unfinished unit has a task, a dependency, or a hold at
      each settled step. The person handling an intervention can preview all
      unfinished units that a cancellation would reach.
- [x] `makew machine check <file>` checks waiting-state metadata and role
      routing, requires intervention, and warns when the last intervention tier
      lacks a person.
- [x] The smaller TypeScript machine has implement, verify, and intervention
      phases. The same executable runs and restores it alongside the default
      machine.

Older inbox entries without a machine key continue to select the default unit.
Replay uses the historical audit interval to recover a lost worker's timing when
the run record has no timed answer. It reports missing or ambiguous failure
timing and rejects recordings that reference files through symbolic links. An
event stream from another machine version requires an adapter.

Mutation checks covered skipped starts that falsely passed parity, loss matching
across task boundaries, discarding the recorded session on retry, rejecting an
invocation interrupted before it could start a process, omitted startup delay,
listing finished units or passed dependencies, a task with no visible reason for
waiting, a cancel preview that stopped at direct dependents, missing `up`
handling, and a decision targeting the smaller machine's absent judge phase.

## Deviations from the brief and plan

- The lock creates its temporary file with `wx` and publishes it by hard link. A
  contender sees complete PID metadata as soon as the final path exists.
- The fake harness runs inside the process that owns the durable claim. The
  claim stays after completion so a delayed wrapper still loses the same-key
  race. The standalone fake also emits Codex-shaped JSONL on stdout, with
  synthetic failure kind and quota reset fields for tests.
- Run-record filenames use SHA-256 stems so arbitrary keys fit in one path
  component. The timeline retains the original keys and answer paths.

## Bugs found and fixes

- Workspace symlinks caused false dependency violations. The scan now prunes
  `node_modules`. Internal actor IDs use a `unit:` prefix so public IDs such as
  `constructor` route safely.
- An early checkpoint could omit a quota notification. Checkpoint capture now
  waits through an idle event-loop turn, which preserved quota notifications in
  the swept checkpoints. The pending-child-event regression still demonstrates a
  remaining window.
- Killing an early wrapper could leave its separate harness alive. The
  real-process regression now kills the recorded PID and verifies process exit
  and session-preserving retry.
- Replay initially rejected runs interrupted by a boot hold before any process
  started. Such invocations now wait for the recorded hold. The parity check
  counts actual start rows, including when a hold interrupts a scheduled start.
  Scratch directories also stay writable for SQLite and cleanup when the source
  is read-only.

## Upstream candidates

- [XState #5892](https://github.com/statelyai/xstate/issues/5892) tracks pending
  events lost on restore. The paired pending and settled child-completion tests
  are candidates for the upstream recovery suite. The M1 capture regression
  remains an expected failure.

## Open questions and defaults

- **When should checkpoint capture change?** Keep the current capture function
  until the pinned XState version passes the pending-event regression, then
  rerun the crash sweep with the upstream recovery API.
- **How should real harnesses keep their identity after wrapper exit?** Verify
  the process group when the harness runs as a child. Evaluate same-PID
  replacement on platforms that support it.
- **How should the follower handle long logs?** Tail by byte offset and retain
  an incomplete line for the next read.
- **How should a future recording identify failure timing?** Record failure
  timestamps with their run keys and keep audit-based recovery for older
  recordings.

## Verification

`pnpm lint` and `pnpm typecheck` passed. `pnpm test` ran 21 files in 11.66
seconds on the development machine, with 93 passing tests and one expected
failure for XState #5892.
