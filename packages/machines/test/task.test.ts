import { createEffectActor, sendAndAwait, waitFor } from "@xstate/effect";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, test } from "vitest";
import { type RunnerInput, Workers } from "../src/runner.ts";
import { task } from "../src/task.ts";
import { createWorld } from "./workers.ts";

const worker = {
	harness: "codex",
	model: "model",
	account: "account",
} as const;
const spec = {
	taskId: "U/1.implement.main",
	phase: "implement",
	repo: "repo",
	title: "test",
	tier: "main",
	workers: [worker] as const,
	notes: [],
	prior: undefined,
	attemptLimit: 2,
} as const;

describe("task retries", () => {
	test("retries a lost run with its session then routes a reported verdict", async () => {
		const starts: RunnerInput[] = [];
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const actor = yield* createEffectActor(task, {
					input: { spec, holds: [] },
				});
				const snapshot = yield* waitFor(
					actor,
					(state) => state.status === "done",
				);
				return snapshot.output?.outcome;
			}).pipe(
				Effect.scoped,
				Effect.provideService(Workers, {
					run: (input, emit) =>
						Effect.sync(() => {
							starts.push(input);
							emit({ type: "runner.started", sessionId: "session" });
							if (input.run === 1)
								emit({ type: "runner.failed", reason: "lost", detail: "lost" });
							else
								emit({
									type: "runner.report",
									outcome: {
										kind: "done",
										verdict: "fail",
										detail: "findings",
									},
								});
						}),
				}),
			),
		);
		expect(starts.map(({ key, resume }) => [key, resume])).toEqual([
			["U/1.implement.main#1", undefined],
			["U/1.implement.main#2", "session"],
		]);
		expect(outcome).toEqual({
			kind: "done",
			verdict: "fail",
			detail: "findings",
		});
	});

	test("exhausts after two worker crashes", async () => {
		let starts = 0;
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const actor = yield* createEffectActor(task, {
					input: { spec, holds: [] },
				});
				const snapshot = yield* waitFor(
					actor,
					(state) => state.status === "done",
				);
				return snapshot.output?.outcome;
			}).pipe(
				Effect.scoped,
				Effect.provideService(Workers, {
					run: (_input, emit) =>
						Effect.sync(() => {
							starts++;
							emit({
								type: "runner.failed",
								reason: "crashed",
								detail: "crash",
							});
						}),
				}),
			),
		);
		expect(starts).toBe(2);
		expect(outcome).toEqual({ kind: "exhausted", detail: "crash" });
	});

	test("exhausts a runner that ends without a report", async () => {
		let starts = 0;
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const actor = yield* createEffectActor(task, {
					input: { spec, holds: [] },
				});
				const snapshot = yield* waitFor(
					actor,
					(state) => state.status === "done",
				);
				return snapshot.output?.outcome;
			}).pipe(
				Effect.scoped,
				Effect.provideService(Workers, {
					run: () =>
						Effect.sync(() => {
							starts++;
						}),
				}),
			),
		);
		expect(starts).toBe(2);
		expect(outcome).toEqual({
			kind: "exhausted",
			detail: "runner ended without an outcome",
		});
	});
});

test("a parked run resumes its worker and session without spending an attempt", async () => {
	const starts: RunnerInput[] = [];
	const result = await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(task, {
				input: { spec, holds: [] },
			});
			yield* waitFor(actor, (state) => state.context.sessionId === "session");
			yield* sendAndAwait(actor, {
				type: "hold.placed",
				hold: { id: "pause", scope: { kind: "all" }, mode: "hard" },
			});
			expect(actor.getSnapshot().value).toBe("held");
			yield* sendAndAwait(actor, { type: "hold.lifted", holdId: "pause" });
			return (yield* waitFor(actor, (state) => state.status === "done")).output
				?.outcome;
		}).pipe(
			Effect.scoped,
			Effect.provideService(Workers, {
				run: (input, emit) =>
					Effect.gen(function* () {
						starts.push(input);
						emit({ type: "runner.started", sessionId: "session" });
						if (input.run === 1) return yield* Effect.never;
						if (input.run === 2)
							emit({ type: "runner.failed", reason: "lost", detail: "lost" });
						else
							emit({
								type: "runner.report",
								outcome: { kind: "done", verdict: "pass", detail: "pass" },
							});
					}),
			}),
		),
	);
	expect(starts.map((input) => input.resume)).toEqual([
		undefined,
		"session",
		"session",
	]);
	expect(result).toEqual({ kind: "done", verdict: "pass", detail: "pass" });
});

test("a stale human answer cannot complete a replacement task", async () => {
	const human = {
		...spec,
		workers: [
			{ harness: "person", model: "person", account: "person" } as const,
		] as const,
	};
	const decision = {
		kind: "done",
		verdict: "decision",
		decision: { kind: "cancel" },
	} as const;
	const result = await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(task, {
				input: { spec: human, holds: [] },
			});
			yield* sendAndAwait(actor, {
				type: "answer",
				taskId: "old",
				outcome: decision,
			});
			expect(actor.getSnapshot().value).toBe("asking");
			yield* sendAndAwait(actor, {
				type: "answer",
				taskId: spec.taskId,
				outcome: decision,
			});
			return (yield* waitFor(actor, (state) => state.status === "done")).output
				?.outcome;
		}).pipe(
			Effect.scoped,
			Effect.provideService(Workers, { run: () => Effect.void }),
		),
	);
	expect(result).toEqual(decision);
});

test("a soft hold lets a running worker finish and blocks its retry", async () => {
	const world = createWorld((input) => ({
		duration: 10,
		event:
			input.run === 1
				? { type: "runner.failed", reason: "lost", detail: "lost" }
				: {
						type: "runner.report",
						outcome: { kind: "done", verdict: "done", detail: "ok" },
					},
	}));
	await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(task, {
				input: { spec, holds: [] },
			});
			yield* waitFor(actor, (state) => state.context.sessionId !== undefined);
			yield* sendAndAwait(actor, {
				type: "hold.placed",
				hold: { id: "soft", mode: "soft", scope: { kind: "all" } },
			});
			expect(actor.getSnapshot().value).toBe("running");
			yield* TestClock.adjust(10);
			expect(actor.getSnapshot().value).toBe("held");
			expect(world.processes).toHaveLength(1);
			yield* sendAndAwait(actor, { type: "hold.lifted", holdId: "soft" });
			yield* TestClock.adjust(10);
			expect(
				(yield* waitFor(actor, (state) => state.status === "done")).output
					?.outcome,
			).toEqual({ kind: "done", verdict: "done", detail: "ok" });
		}).pipe(
			Effect.scoped,
			Effect.provideService(Workers, world.workers),
			Effect.provide(TestClock.layer()),
		),
	);
});

test("a parked task waits for its chosen worker rather than switching", async () => {
	const alternative = { ...worker, model: "other" };
	const input = { ...spec, workers: [worker, alternative] as const };
	const world = createWorld(() => ({
		duration: 10,
		event: {
			type: "runner.report",
			outcome: { kind: "done", verdict: "done", detail: "ok" },
		},
	}));
	await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(task, {
				input: { spec: input, holds: [] },
			});
			yield* waitFor(actor, (state) => state.context.sessionId !== undefined);
			yield* sendAndAwait(actor, {
				type: "hold.placed",
				hold: {
					id: "model",
					mode: "hard",
					scope: { kind: "model", account: "account", model: "model" },
				},
			});
			expect(actor.getSnapshot().value).toBe("held");
			yield* sendAndAwait(actor, {
				type: "hold.placed",
				hold: {
					id: "repo",
					mode: "hard",
					scope: { kind: "repo", repo: "repo" },
				},
			});
			yield* sendAndAwait(actor, { type: "hold.lifted", holdId: "repo" });
			expect(actor.getSnapshot().value).toBe("held");
			yield* TestClock.adjust(20);
			expect(world.processes).toHaveLength(1);
			yield* sendAndAwait(actor, { type: "hold.lifted", holdId: "model" });
			yield* TestClock.adjust(10);
			yield* waitFor(actor, (state) => state.status === "done");
		}).pipe(
			Effect.scoped,
			Effect.provideService(Workers, world.workers),
			Effect.provide(TestClock.layer()),
		),
	);
	expect(world.processes.map((process) => process.input.worker.model)).toEqual([
		"model",
		"model",
	]);
});

test("person tasks ignore hard holds before and after asking", async () => {
	const human = {
		...spec,
		workers: [
			{ harness: "person", model: "person", account: "person" } as const,
		] as const,
	};
	const hold = { id: "pause", mode: "hard", scope: { kind: "all" } } as const;
	await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(task, {
				input: { spec: human, holds: [hold] },
			});
			expect(actor.getSnapshot().value).toBe("asking");
			yield* sendAndAwait(actor, {
				type: "hold.placed",
				hold: { ...hold, id: "other" },
			});
			expect(actor.getSnapshot().value).toBe("asking");
			yield* sendAndAwait(actor, {
				type: "answer",
				taskId: human.taskId,
				outcome: {
					kind: "done",
					verdict: "decision",
					decision: { kind: "cancel" },
				},
			});
			expect(
				(yield* waitFor(actor, (state) => state.status === "done")).output
					?.worker.harness,
			).toBe("person");
		}).pipe(
			Effect.scoped,
			Effect.provideService(Workers, { run: () => Effect.void }),
		),
	);
});

test("a restored parked run preserves the session and crash retry budget", async () => {
	const starts: RunnerInput[] = [];
	const outcome = await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(task, {
				input: { spec, holds: [] },
			});
			const snapshot = yield* waitFor(
				actor,
				(state) => state.status === "done",
			);
			return snapshot.output?.outcome;
		}).pipe(
			Effect.scoped,
			Effect.provideService(Workers, {
				run: (input, emit) =>
					Effect.sync(() => {
						starts.push(input);
						if (input.run === 1) {
							emit({ type: "runner.started", sessionId: "session" });
							emit({ type: "runner.parked" });
						} else if (input.run === 2)
							emit({ type: "runner.failed", reason: "lost", detail: "lost" });
						else
							emit({
								type: "runner.report",
								outcome: { kind: "done", verdict: "done", detail: "finished" },
							});
					}),
			}),
		),
	);
	expect(starts.map(({ run, resume }) => [run, resume])).toEqual([
		[1, undefined],
		[2, "session"],
		[3, "session"],
	]);
	expect(outcome).toMatchObject({ kind: "done", verdict: "done" });
});
