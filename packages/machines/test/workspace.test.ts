import type { Routes } from "@makewhether/domain";
import {
	createEffectActor,
	EventRejectedError,
	sendAndAwait,
} from "@xstate/effect";
import { Effect, References } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import type { EventFrom } from "xstate";
import { Workers } from "../src/runner.ts";
import { workspace } from "../src/workspace.ts";
import { createWorld } from "./workers.ts";

const worker = {
	account: "account",
	model: "model",
	harness: "codex",
} as const;
const tier = { tier: "worker", workers: [worker] as const, rules: {} };
const personWorker = {
	harness: "person",
	model: "person",
	account: "person",
} as const;
const personTier = {
	tier: "person",
	workers: [personWorker] as const,
	rules: {},
};
const routes: Routes = {
	implement: [tier],
	verify: [tier],
	judge: [tier],
	intervene: [personTier],
};

test("reserved-looking unit IDs can be held and resolve dependencies", async () => {
	const world = createWorld((input) => ({
		duration: 10,
		event: {
			type: "runner.report",
			outcome: {
				kind: "done",
				verdict: input.spec.phase === "implement" ? "done" : "pass",
				detail: "ok",
			},
		},
	}));
	const result = await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(workspace);
			yield* sendAndAwait(actor, {
				type: "hold.add",
				hold: { id: "pause", mode: "hard", scope: { kind: "all" } },
			});
			for (const id of ["constructor", "__proto__"]) {
				yield* sendAndAwait(actor, {
					type: "unit.add",
					id,
					repo: "repo",
					title: id,
					deps: id === "__proto__" ? ["constructor"] : [],
					routes,
					maxRounds: 2,
					interventionCap: 2,
				});
			}
			expect(actor.getSnapshot().status).toBe("active");
			expect(
				actor
					.getSnapshot()
					.children["unit:constructor"]?.getSnapshot()
					.children.task?.getSnapshot().value,
			).toBe("held");
			expect(
				actor.getSnapshot().children["unit:__proto__"]?.getSnapshot().value,
			).toBe("queued");
			expect(world.processes).toHaveLength(0);
			yield* sendAndAwait(actor, { type: "hold.lift", holdId: "pause" });
			for (let step = 0; step < 100; step++) {
				const finished = actor.getSnapshot().context.finished;
				if (
					getResult(finished, "constructor") === "passed" &&
					getResult(finished, "__proto__") === "passed"
				)
					return finished;
				yield* TestClock.adjust(10);
			}
			throw new Error("reserved-looking IDs did not finish");
		}).pipe(
			Effect.scoped,
			Effect.provideService(Workers, world.workers),
			Effect.provide(TestClock.layer()),
			Effect.provideService(References.MinimumLogLevel, "Warn"),
		),
	);
	expect(getResult(result, "constructor")).toBe("passed");
	expect(getResult(result, "__proto__")).toBe("passed");
	const predecessor = world.processes.find(
		(item) =>
			item.input.spec.taskId.startsWith("constructor/") &&
			item.input.spec.phase === "judge",
	);
	const dependent = world.processes.find((item) =>
		item.input.spec.taskId.startsWith("__proto__/"),
	);
	expect(predecessor).toBeDefined();
	expect(dependent?.started).toBeGreaterThanOrEqual(
		predecessor?.ended ?? Number.POSITIVE_INFINITY,
	);
});

function getResult(results: Readonly<Record<string, string>>, id: string) {
	return results[id];
}

test.each([
	["omitted", {}, 2],
	["undefined", { attemptLimit: undefined }, 2],
	["explicit", { attemptLimit: 3 }, 3],
] as const)(
	"%s attempt limit handles lost runs",
	async (_name, limit, expected) => {
		const world = createWorld(() => ({
			duration: 10,
			event: { type: "runner.failed", reason: "lost", detail: "lost" },
		}));
		const person = {
			account: "person",
			model: "person",
			harness: "person",
		} as const;
		const testRoutes: Routes = {
			...routes,
			intervene: [{ tier: "person", workers: [person], rules: {} }],
		};
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
					...limit,
				});
				for (let step = 0; step < 30; step++) {
					const current = actor
						.getSnapshot()
						.children["unit:U"]?.getSnapshot()
						.children.task?.getSnapshot();
					if (current?.value === "asking") return current.value;
					yield* TestClock.adjust(10);
				}
				throw new Error("unit did not exhaust its attempts");
			}).pipe(
				Effect.scoped,
				Effect.provideService(Workers, world.workers),
				Effect.provide(TestClock.layer()),
				Effect.provideService(References.MinimumLogLevel, "Warn"),
			),
		);
		expect(result).toBe("asking");
		expect(
			world.processes.filter((item) => item.input.spec.phase === "implement"),
		).toHaveLength(expected);
	},
);

test("a person's cancellation cascades through queued and later dependents, while passed dependencies release work", async () => {
	const person = {
		account: "person",
		model: "person",
		harness: "person",
	} as const;
	const testRoutes: Routes = {
		...routes,
		intervene: [{ tier: "person", workers: [person], rules: {} }],
	};
	const world = createWorld((input) => {
		const passing =
			input.spec.taskId.startsWith("P/") || input.spec.taskId.startsWith("Q/");
		return {
			duration: 10,
			event: {
				type: "runner.report",
				outcome: passing
					? {
							kind: "done",
							verdict: input.spec.phase === "implement" ? "done" : "pass",
							detail: "ok",
						}
					: { kind: "failed", detail: "blocked" },
			},
		};
	});
	const result = await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(workspace);
			for (const [id, deps] of [
				["D", []],
				["A", ["D"]],
				["B", ["D"]],
				["C", ["A", "B"]],
				["P", []],
			] as const) {
				yield* sendAndAwait(actor, {
					type: "unit.add",
					id,
					repo: "repo",
					title: id,
					deps,
					routes: testRoutes,
					maxRounds: 2,
					interventionCap: 2,
				});
			}
			let answered = false;
			let added = false;
			for (let step = 0; step < 200; step++) {
				const root = actor.getSnapshot();
				const ask = root.children["unit:D"]
					?.getSnapshot()
					.children.task?.getSnapshot();
				if (!answered && ask?.value === "asking") {
					yield* sendAndAwait(actor, {
						type: "task.answer",
						taskId: ask.context.spec.taskId,
						outcome: {
							kind: "done",
							verdict: "decision",
							decision: { kind: "cancel" },
						},
					});
					answered = true;
				}
				if (
					!added &&
					root.context.finished.D === "cancelled" &&
					root.context.finished.P === "passed"
				) {
					yield* sendAndAwait(actor, {
						type: "unit.add",
						id: "L",
						repo: "repo",
						title: "L",
						deps: ["D"],
						routes: testRoutes,
						maxRounds: 2,
						interventionCap: 2,
					});
					yield* sendAndAwait(actor, {
						type: "unit.add",
						id: "Q",
						repo: "repo",
						title: "Q",
						deps: ["P"],
						routes: testRoutes,
						maxRounds: 2,
						interventionCap: 2,
					});
					added = true;
				}
				if (Object.keys(root.context.finished).length === 7)
					return root.context;
				yield* TestClock.adjust(10);
			}
			throw new Error("cascade did not settle");
		}).pipe(
			Effect.scoped,
			Effect.provideService(Workers, world.workers),
			Effect.provide(TestClock.layer()),
			Effect.provideService(References.MinimumLogLevel, "Warn"),
		),
	);
	expect(result.finished).toEqual({
		D: "cancelled",
		A: "cancelled",
		B: "cancelled",
		C: "cancelled",
		L: "cancelled",
		P: "passed",
		Q: "passed",
	});
	expect(result.cancellationReasons.A).toBe("D");
	expect(result.cancellationReasons.B).toBe("D");
	expect(["A", "B"]).toContain(result.cancellationReasons.C);
	expect(result.cancellationReasons.L).toBe("D");
	expect(
		world.processes.some((process) =>
			process.input.spec.taskId.startsWith("Q/"),
		),
	).toBe(true);
	expect(
		world.processes.some((process) =>
			/^(A|B|C|L)\//.test(process.input.spec.taskId),
		),
	).toBe(false);
});

test("agent cancel escalates with analysis; the selected person may cancel", async () => {
	const person = {
		account: "person",
		model: "person",
		harness: "person",
	} as const;
	const testRoutes: Routes = {
		...routes,
		intervene: [
			{ tier: "mixed", workers: [worker, person], rules: {} },
			{ tier: "person", workers: [person], rules: {} },
		],
	};
	const world = createWorld((input) => ({
		duration: 10,
		event: {
			type: "runner.report",
			outcome:
				input.spec.phase === "intervene"
					? {
							kind: "done",
							verdict: "decision",
							decision: { kind: "cancel", analysis: "unsafe to continue" },
						}
					: { kind: "failed", detail: "blocked" },
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
			yield* sendAndAwait(actor, {
				type: "unit.add",
				id: "dependent",
				repo: "repo",
				title: "dependent",
				deps: ["U"],
				routes: testRoutes,
				maxRounds: 2,
				interventionCap: 2,
			});
			let answered = false;
			for (let step = 0; step < 30; step++) {
				const current = actor
					.getSnapshot()
					.children["unit:U"]?.getSnapshot()
					.children.task?.getSnapshot();
				if (current?.value === "asking" && !answered) {
					expect(current.context.worker?.harness).toBe("person");
					expect(actor.getSnapshot().context.finished.U).toBeUndefined();
					expect(
						actor.getSnapshot().context.finished.dependent,
					).toBeUndefined();
					expect(
						actor.getSnapshot().children["unit:dependent"]?.getSnapshot().value,
					).toBe("queued");
					expect(current.context.spec.prior).toEqual({
						tier: "mixed",
						outcome: {
							kind: "done",
							verdict: "decision",
							decision: { kind: "cancel", analysis: "unsafe to continue" },
						},
					});
					yield* sendAndAwait(actor, {
						type: "task.answer",
						taskId: current.context.spec.taskId,
						outcome: {
							kind: "done",
							verdict: "decision",
							decision: { kind: "cancel" },
						},
					});
					answered = true;
				}
				const finished = actor.getSnapshot().context.finished;
				if (finished.U === "cancelled" && finished.dependent === "cancelled") {
					expect(answered).toBe(true);
					return finished;
				}
				yield* TestClock.adjust(10);
			}
			throw new Error("person decision did not finish");
		}).pipe(
			Effect.scoped,
			Effect.provideService(Workers, world.workers),
			Effect.provide(TestClock.layer()),
			Effect.provideService(References.MinimumLogLevel, "Warn"),
		),
	);
	expect(result).toEqual({ U: "cancelled", dependent: "cancelled" });
	expect(
		world.processes.find((process) => process.input.spec.phase === "intervene")
			?.input.worker.harness,
	).toBe("codex");
});

test("cancel authority follows the selected person in a mixed fallback tier", async () => {
	const person = {
		account: "person",
		model: "person",
		harness: "person",
	} as const;
	const starter = {
		account: "local",
		model: "shell",
		harness: "shell",
	} as const;
	const testRoutes: Routes = {
		...routes,
		implement: [{ tier: "start", workers: [starter], rules: {} }],
		intervene: [
			{ tier: "mixed", workers: [worker, person], rules: {} },
			personTier,
		],
	};
	const world = createWorld(() => ({
		duration: 10,
		event: {
			type: "runner.report",
			outcome: { kind: "failed", detail: "blocked" },
		},
	}));
	const result = await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(workspace);
			yield* sendAndAwait(actor, {
				type: "hold.add",
				hold: {
					id: "account",
					mode: "hard",
					scope: { kind: "account", account: worker.account },
				},
			});
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
			for (let step = 0; step < 20; step++) {
				const current = actor
					.getSnapshot()
					.children["unit:U"]?.getSnapshot()
					.children.task?.getSnapshot();
				if (current?.value === "asking") {
					expect(current.context.worker?.harness).toBe("person");
					yield* sendAndAwait(actor, {
						type: "task.answer",
						taskId: current.context.spec.taskId,
						outcome: {
							kind: "done",
							verdict: "decision",
							decision: { kind: "cancel" },
						},
					});
				}
				if (actor.getSnapshot().context.finished.U)
					return actor.getSnapshot().context.finished.U;
				yield* TestClock.adjust(10);
			}
			throw new Error("fallback person did not finish");
		}).pipe(
			Effect.scoped,
			Effect.provideService(Workers, world.workers),
			Effect.provide(TestClock.layer()),
			Effect.provideService(References.MinimumLogLevel, "Warn"),
		),
	);
	expect(result).toBe("cancelled");
});

test("manual hold lift cancels its timer before the id is reused", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(workspace);
			yield* sendAndAwait(actor, {
				type: "hold.request",
				holdId: "reused",
				scope: { kind: "all" },
				at: 0,
				resetsAt: 100,
			});
			yield* TestClock.adjust(10);
			yield* sendAndAwait(actor, { type: "hold.lift", holdId: "reused" });
			yield* sendAndAwait(actor, {
				type: "hold.add",
				hold: { id: "reused", mode: "hard", scope: { kind: "all" } },
			});
			yield* TestClock.adjust(100);
			expect(actor.getSnapshot().context.holds.map((hold) => hold.id)).toEqual([
				"reused",
			]);
		}).pipe(
			Effect.scoped,
			Effect.provideService(Workers, { run: () => Effect.void }),
			Effect.provide(TestClock.layer()),
		),
	);
});

const noWorkers = { run: () => Effect.die("unexpected worker") };

test.each([
	{ name: "a self-dependency", units: [["A", ["A"]]] },
	{
		name: "a two-unit cycle",
		units: [
			["A", ["B"]],
			["B", ["A"]],
		],
	},
	{
		name: "a three-unit cycle",
		units: [
			["A", ["B"]],
			["B", ["C"]],
			["C", ["A"]],
		],
	},
] as const)(
	"refuses $name before spawning the last unit",
	async ({ units }) => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const actor = yield* createEffectActor(workspace);
				for (const [id, deps] of units) {
					yield* sendAndAwait(actor, {
						type: "unit.add",
						id,
						deps,
						routes,
						repo: "repo",
						title: id,
						maxRounds: 2,
						interventionCap: 2,
						attemptLimit: 2,
					});
				}
				const orderedIds = units.map(([id]) => id);
				const snapshot = actor.getSnapshot();
				expect(snapshot.context.units.map(({ id }) => id)).toEqual(
					orderedIds.slice(0, -1),
				);
				expect(snapshot.children[`unit:${orderedIds.at(-1)}`]).toBeUndefined();
			}).pipe(Effect.scoped, Effect.provideService(Workers, noWorkers)),
		);
	},
);

test("quota holds use the reset deadline relative to the runner report", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(workspace);
			yield* TestClock.adjust(50);
			yield* sendAndAwait(actor, {
				type: "hold.request",
				holdId: "quota",
				scope: { kind: "all" },
				at: 50,
				resetsAt: 100,
			});
			yield* TestClock.adjust(49);
			expect(actor.getSnapshot().context.holds.map(({ id }) => id)).toEqual([
				"quota",
			]);
			yield* TestClock.adjust(1);
			expect(actor.getSnapshot().context.holds).toEqual([]);
		}).pipe(
			Effect.scoped,
			Effect.provide(TestClock.layer()),
			Effect.provideService(Workers, noWorkers),
		),
	);
});

test("direct workspace sends reject invalid IDs, forward dependencies and final tiers", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(workspace);
			const add = {
				type: "unit.add" as const,
				id: "A",
				title: "work",
				repo: "repo",
				deps: [],
				routes,
				maxRounds: 2,
				interventionCap: 2,
				attemptLimit: 2,
			};
			const invalid = [
				{ ...add, id: "A/1.implement.x" },
				{
					...add,
					routes: {
						...routes,
						implement: [{ ...tier, tier: "x/1.implement.y" }],
					},
				},
				{ ...add, deps: ["B.C"] },
				{ ...add, routes: { ...routes, intervene: [tier] } },
				{
					...add,
					routes: {
						...routes,
						intervene: [{ ...tier, workers: [worker, personWorker] }],
					},
				},
			] satisfies EventFrom<typeof workspace>[];
			for (const event of invalid) {
				const result = yield* Effect.result(sendAndAwait(actor, event));
				expect(result._tag).toBe("Failure");
				if (result._tag === "Failure")
					expect(result.failure).toBeInstanceOf(EventRejectedError);
			}
			expect(actor.getSnapshot().context.units).toEqual([]);
			yield* sendAndAwait(actor, { ...add, deps: ["B"] });
			expect(actor.getSnapshot().children["unit:A"]?.getSnapshot().value).toBe(
				"queued",
			);
		}).pipe(Effect.scoped, Effect.provideService(Workers, noWorkers)),
	);
});

test("a checkpoint after the workspace receives a quota request resumes at the reset", async () => {
	const world = createWorld((input, prior) => ({
		duration: 10,
		event:
			input.spec.phase === "implement" && prior === 0
				? {
						type: "runner.limit",
						holdId: "quota",
						scope: { kind: "all" },
						at: 10,
						resetsAt: 100,
					}
				: {
						type: "runner.report",
						outcome: {
							kind: "done",
							verdict: input.spec.phase === "implement" ? "done" : "pass",
							detail: "ok",
						},
					},
	}));
	await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(workspace);
			type Snapshot = ReturnType<typeof actor.getPersistedSnapshot>;
			let checkpoint: Snapshot | undefined;
			let requested = false;
			actor.inspect((inspection) => {
				if (
					inspection.type === "@xstate.transition" &&
					"id" in inspection.actorRef &&
					inspection.actorRef.id === workspace.id &&
					inspection.event.type === "hold.request"
				)
					requested = true;
			});
			actor.subscribe(() => {
				if (requested && !checkpoint)
					checkpoint = JSON.parse(JSON.stringify(actor.getPersistedSnapshot()));
			});
			yield* sendAndAwait(actor, {
				type: "unit.add",
				id: "A",
				title: "quota",
				repo: "repo",
				deps: [],
				routes,
				maxRounds: 2,
				interventionCap: 2,
				attemptLimit: 2,
			});
			yield* TestClock.adjust(25);
			if (!checkpoint)
				throw new Error("quota request checkpoint was not captured");
			const restored = yield* createEffectActor(workspace, {
				snapshot: checkpoint,
			});
			const task = () =>
				restored
					.getSnapshot()
					.children["unit:A"]?.getSnapshot()
					.children.task?.getSnapshot();
			expect(task()?.value).toBe("held");
			expect(restored.getSnapshot().context.holds.map(({ id }) => id)).toEqual([
				"quota",
			]);
			yield* TestClock.adjust(74);
			expect(task()?.value).toBe("held");
			yield* TestClock.adjust(1);
			expect(restored.getSnapshot().context.holds).toEqual([]);
			expect(task()?.value).toBe("running");
		}).pipe(
			Effect.scoped,
			Effect.provide(TestClock.layer()),
			Effect.provideService(Workers, world.workers),
		),
	);
});

test("a quota request immediately followed by a lift leaves no stale expiry", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(workspace);
			actor.send({
				type: "hold.request",
				holdId: "quota",
				scope: { kind: "all" },
				at: 0,
				resetsAt: 100,
			});
			actor.send({ type: "hold.lift", holdId: "quota" });
			yield* TestClock.adjust(1);
			expect(actor.getSnapshot().context.holds).toEqual([]);
			yield* sendAndAwait(actor, {
				type: "hold.add",
				hold: { id: "quota", mode: "soft", scope: { kind: "all" } },
			});
			yield* TestClock.adjust(100);
			expect(actor.getSnapshot().context.holds).toEqual([
				{ id: "quota", mode: "soft", scope: { kind: "all" } },
			]);
		}).pipe(
			Effect.scoped,
			Effect.provide(TestClock.layer()),
			Effect.provideService(Workers, noWorkers),
		),
	);
});
