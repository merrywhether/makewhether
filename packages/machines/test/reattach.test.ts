import { createEffectActor, waitFor } from "@xstate/effect";
import { Effect, References } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { Workers } from "../src/runner.ts";
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

test.each([5_000, 15_000])(
	"a worker survives engine loss and is reattached or replayed after %i ms",
	async (downtime) => {
		const world = createWorld(() => ({
			duration: 10_000,
			event: {
				type: "runner.report",
				outcome: { kind: "done", verdict: "done", detail: "done" },
			},
		}));
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const snapshot = yield* Effect.gen(function* () {
					const actor = yield* createEffectActor(task, {
						input: { spec, holds: [] },
					});
					yield* waitFor(
						actor,
						(state) => state.context.sessionId !== undefined,
					);
					const persisted = actor.getPersistedSnapshot();
					world.crashing = true;
					return persisted;
				}).pipe(Effect.scoped);
				world.crashing = false;
				yield* TestClock.adjust(downtime);
				const actor = yield* createEffectActor(task, { snapshot });
				yield* TestClock.adjust(20_000);
				const completed = yield* waitFor(
					actor,
					(state) => state.status === "done",
				);
				return {
					output: completed.output?.outcome,
					failures: completed.context.failures,
				};
			}).pipe(
				Effect.scoped,
				Effect.provideService(Workers, world.workers),
				Effect.provide(TestClock.layer()),
				Effect.provideService(References.MinimumLogLevel, "Warn"),
			),
		);
		expect(world.calls.map((call) => call.mode)).toEqual([
			"start",
			downtime < 10_000 ? "reattach" : "replay",
		]);
		expect(world.processes).toHaveLength(1);
		expect(world.processes[0]?.stopped).toBeUndefined();
		expect(result).toEqual({
			output: { kind: "done", verdict: "done", detail: "done" },
			failures: 0,
		});
	},
);

test("replayed quota reports the original deadline and current time", async () => {
	const world = createWorld((_input, _prior, now) => ({
		duration: 10_000,
		event: {
			type: "runner.limit",
			holdId: "quota",
			scope: { kind: "account", account: "account" },
			at: now + 10_000,
			resetsAt: now + 11_000,
		},
	}));
	const events: import("../src/runner.ts").RunnerEvent[] = [];
	await Effect.runPromise(
		Effect.gen(function* () {
			yield* Effect.gen(function* () {
				const actor = yield* createEffectActor(task, {
					input: { spec, holds: [] },
				});
				yield* waitFor(actor, (state) => state.context.sessionId !== undefined);
				world.crashing = true;
			}).pipe(Effect.scoped);
			world.crashing = false;
			yield* TestClock.adjust(15_000);
			const input = world.calls[0]?.input;
			if (!input) throw new Error("worker did not start");
			yield* world.workers.run(input, (event) => events.push(event));
		}).pipe(
			Effect.scoped,
			Effect.provideService(Workers, world.workers),
			Effect.provide(TestClock.layer()),
		),
	);
	expect(events).toContainEqual({
		type: "runner.limit",
		holdId: "quota",
		scope: { kind: "account", account: "account" },
		at: 15_000,
		resetsAt: 11_000,
	});
});
