import type { Decision, Outcome, Routes } from "@makewhether/domain";
import { createEffectActor, sendAndAwait } from "@xstate/effect";
import { Effect, References } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { Workers } from "../src/runner.ts";
import { workspace } from "../src/workspace.ts";
import { createWorld } from "./workers.ts";

const agent = { harness: "codex", model: "agent", account: "agent" } as const;
const person = {
	harness: "person",
	model: "person",
	account: "person",
} as const;
const step = { tier: "agent", workers: [agent] as const, rules: {} };
const human = { tier: "person", workers: [person] as const, rules: {} };
const routes: Routes = {
	implement: [step],
	verify: [step],
	judge: [step],
	intervene: [human],
};

test.each([
	["resume default", { kind: "resume" }, "implement", 2],
	["resume selected", { kind: "resume", phase: "judge" }, "judge", 2],
	["raise default", { kind: "raise-limit" }, "implement", 3],
	["raise selected", { kind: "raise-limit", phase: "verify" }, "verify", 3],
] as const satisfies readonly (readonly [string, Decision, string, number])[])(
	"%s uses the selected phase and limit",
	async (_name, decision, phase, maxRounds) => {
		const world = createWorld(() => ({
			duration: 10,
			event: {
				type: "runner.report",
				outcome: { kind: "failed", detail: "blocked" },
			},
		}));
		await Effect.runPromise(
			Effect.gen(function* () {
				const actor = yield* createEffectActor(workspace);
				yield* sendAndAwait(actor, {
					type: "unit.add",
					id: "U",
					repo: "repo",
					title: "U",
					deps: [],
					routes,
					maxRounds: 2,
					interventionCap: 2,
				});
				for (let index = 0; index < 20; index++) {
					const unit = actor.getSnapshot().children["unit:U"]?.getSnapshot();
					const task = unit?.children.task?.getSnapshot();
					if (task?.value === "asking") {
						yield* sendAndAwait(actor, {
							type: "task.answer",
							taskId: task.context.spec.taskId,
							outcome: { kind: "done", verdict: "decision", decision },
						});
						const next = actor.getSnapshot().children["unit:U"]?.getSnapshot();
						expect(next?.value).toBe(phase);
						expect(next?.context.maxRounds).toBe(maxRounds);
						return;
					}
					yield* TestClock.adjust(10);
				}
				throw new Error("intervention not reached");
			}).pipe(
				Effect.scoped,
				Effect.provideService(Workers, world.workers),
				Effect.provide(TestClock.layer()),
				Effect.provideService(References.MinimumLogLevel, "Warn"),
			),
		);
	},
);

test("unsure moves to the next judge tier by default", async () => {
	const second = { ...step, tier: "second" };
	const testRoutes: Routes = { ...routes, judge: [step, second] };
	const world = createWorld((input) => ({
		duration: 10,
		event: {
			type: "runner.report",
			outcome: {
				kind: "done",
				verdict:
					input.spec.phase === "implement"
						? "done"
						: input.spec.phase === "judge" && input.spec.tier === "agent"
							? "unsure"
							: "pass",
				detail: "ok",
			},
		},
	}));
	const result = await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(workspace);
			yield* sendAndAwait(actor, {
				type: "unit.add",
				id: "U",
				repo: "repo",
				title: "U",
				deps: [],
				routes: testRoutes,
				maxRounds: 2,
				interventionCap: 2,
			});
			for (let index = 0; index < 20; index++) {
				if (actor.getSnapshot().context.finished.U)
					return actor.getSnapshot().context.finished.U;
				yield* TestClock.adjust(10);
			}
			throw new Error("judge did not finish");
		}).pipe(
			Effect.scoped,
			Effect.provideService(Workers, world.workers),
			Effect.provide(TestClock.layer()),
			Effect.provideService(References.MinimumLogLevel, "Warn"),
		),
	);
	expect(result).toBe("passed");
	expect(
		world.processes
			.filter((item) => item.input.spec.phase === "judge")
			.map((item) => item.input.spec.tier),
	).toEqual(["agent", "second"]);
});

test("intervention at the cap starts at agent; the next starts at person", async () => {
	const testRoutes: Routes = { ...routes, intervene: [step, human] };
	const world = createWorld((input) => ({
		duration: 10,
		event: {
			type: "runner.report",
			outcome:
				input.spec.phase === "intervene"
					? { kind: "done", verdict: "unsure", detail: "unsure" }
					: { kind: "failed", detail: "blocked" },
		},
	}));
	await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(workspace);
			yield* sendAndAwait(actor, {
				type: "unit.add",
				id: "U",
				repo: "repo",
				title: "U",
				deps: [],
				routes: testRoutes,
				maxRounds: 2,
				interventionCap: 1,
			});
			let answered = false;
			for (let index = 0; index < 30; index++) {
				const unit = actor.getSnapshot().children["unit:U"]?.getSnapshot();
				const task = unit?.children.task?.getSnapshot();
				if (task?.value === "asking" && !answered) {
					expect(unit?.context.interventions).toBe(1);
					expect(
						world.processes.filter(
							(item) => item.input.spec.phase === "intervene",
						),
					).toHaveLength(1);
					yield* sendAndAwait(actor, {
						type: "task.answer",
						taskId: task.context.spec.taskId,
						outcome: {
							kind: "done",
							verdict: "decision",
							decision: { kind: "resume" },
						},
					});
					answered = true;
				} else if (
					task?.value === "asking" &&
					unit?.context.interventions === 2
				) {
					expect(
						world.processes.filter(
							(item) => item.input.spec.phase === "intervene",
						),
					).toHaveLength(1);
					return;
				}
				yield* TestClock.adjust(10);
			}
			throw new Error("second intervention not reached");
		}).pipe(
			Effect.scoped,
			Effect.provideService(Workers, world.workers),
			Effect.provide(TestClock.layer()),
			Effect.provideService(References.MinimumLogLevel, "Warn"),
		),
	);
});

test.each([
	{ kind: "done", verdict: "unsure", detail: "uncertain" },
	{ kind: "done", verdict: "decision", decision: { kind: "raise-limit" } },
] as const satisfies readonly Outcome[])(
	"intervention verdict $verdict parks a taskless episode and rejects invalid recovery decisions",
	async (outcome) => {
		const world = createWorld(() => ({
			duration: 10,
			event: {
				type: "runner.report",
				outcome: { kind: "failed", detail: "blocked" },
			},
		}));
		await Effect.runPromise(
			Effect.gen(function* () {
				const actor = yield* createEffectActor(workspace);
				yield* sendAndAwait(actor, {
					type: "unit.add",
					id: "U",
					repo: "repo",
					title: "U",
					deps: [],
					routes,
					maxRounds: Number.MAX_SAFE_INTEGER,
					interventionCap: 2,
				});
				for (let i = 0; i < 20; i++) {
					const unit = actor.getSnapshot().children["unit:U"]?.getSnapshot();
					const task = unit?.children.task?.getSnapshot();
					if (task?.value === "asking") {
						yield* sendAndAwait(actor, {
							type: "task.answer",
							taskId: task.context.spec.taskId,
							outcome,
						});
						const stuck = actor.getSnapshot().children["unit:U"]?.getSnapshot();
						expect(stuck?.value).toBe("stuck");
						expect(stuck?.children.task).toBeUndefined();
						expect(stuck?.context.stuck).toMatchObject({
							episode: 1,
							reason: "unhandled-intervention",
						});
						yield* sendAndAwait(actor, {
							type: "unit.decide",
							unitId: "U",
							episode: 2,
							decision: { kind: "resume" },
						});
						expect(
							actor.getSnapshot().children["unit:U"]?.getSnapshot().value,
						).toBe("stuck");
						yield* sendAndAwait(actor, {
							type: "unit.decide",
							unitId: "U",
							episode: 1,
							decision: { kind: "raise-limit" },
						});
						expect(
							actor.getSnapshot().children["unit:U"]?.getSnapshot().context,
						).toEqual(stuck?.context);
						yield* sendAndAwait(actor, {
							type: "unit.decide",
							unitId: "U",
							episode: 1,
							decision: { kind: "resume" },
						});
						const resumed = actor
							.getSnapshot()
							.children["unit:U"]?.getSnapshot();
						expect(resumed?.value).toBe("implement");
						expect(resumed?.context.interventions).toBe(0);
						return;
					}
					yield* TestClock.adjust(10);
				}
				throw new Error("intervention not reached");
			}).pipe(
				Effect.scoped,
				Effect.provideService(Workers, world.workers),
				Effect.provide(TestClock.layer()),
				Effect.provideService(References.MinimumLogLevel, "Warn"),
			),
		);
	},
);
