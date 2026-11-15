import { createEffectActor, sendAndAwait } from "@xstate/effect";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { Workers } from "../src/runner.ts";
import { smallUnit } from "../src/small-unit.ts";
import { readUnits, workspace } from "../src/workspace.ts";
import { createWorld } from "./workers.ts";

const agent = { harness: "codex", model: "agent", account: "agent" } as const;
const person = {
	harness: "person",
	model: "person",
	account: "person",
} as const;
const step = { tier: "agent", workers: [agent] as const, rules: {} };
const human = { tier: "person", workers: [person] as const, rules: {} };
const routes = {
	implement: [step] as const,
	verify: [step] as const,
	judge: [step] as const,
	intervene: [human] as const,
};
const add = (id: string, deps: string[] = []) => ({
	type: "unit.add" as const,
	id,
	deps,
	repo: "repo",
	title: id,
	routes,
	maxRounds: 2,
	interventionCap: 2,
	attemptLimit: 2,
});

test.each(["unit", "small-unit"] as const)(
	"%s survives JSON restore and completes its own phases",
	async (name) => {
		const world = createWorld((input) => ({
			duration: 10,
			event: {
				type: "runner.report",
				outcome: {
					kind: "done",
					verdict: input.spec.phase === "implement" ? "done" : "pass",
					detail: "done",
				},
			},
		}));
		const finished = await Effect.runPromise(
			Effect.gen(function* () {
				const snapshot = yield* Effect.gen(function* () {
					const actor = yield* createEffectActor(workspace);
					yield* sendAndAwait(
						actor,
						name === "unit" ? add("A") : { ...add("A"), machine: name },
					);
					const saved = actor.getPersistedSnapshot();
					world.crashing = true;
					return JSON.parse(JSON.stringify(saved)) as typeof saved;
				}).pipe(Effect.scoped);
				world.crashing = false;
				const actor = yield* createEffectActor(workspace, { snapshot });
				for (
					let i = 0;
					i < 30 && actor.getSnapshot().context.finished.A !== "passed";
					i++
				)
					yield* TestClock.adjust(10);
				return actor.getSnapshot().context.finished.A;
			}).pipe(
				Effect.scoped,
				Effect.provideService(Workers, world.workers),
				Effect.provide(TestClock.layer()),
			),
		);
		expect(finished).toBe("passed");
		expect(world.processes.map((process) => process.input.spec.phase)).toEqual(
			name === "unit"
				? ["implement", "verify", "judge"]
				: ["implement", "verify"],
		);
	},
);

test("small machine parks an unavailable phase and rejects unsupported recovery", async () => {
	expect(Object.keys(smallUnit.config.states ?? {})).not.toContain("judge");
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
			yield* sendAndAwait(actor, { ...add("A"), machine: "small-unit" });
			for (let i = 0; i < 20; i++) {
				const current = actor
					.getSnapshot()
					.children["unit:A"]?.getSnapshot()
					.children.task?.getSnapshot();
				if (current?.value === "asking") {
					const first = current.context.spec.taskId;
					yield* sendAndAwait(actor, {
						type: "task.answer",
						taskId: first,
						outcome: {
							kind: "done",
							verdict: "decision",
							decision: { kind: "resume", phase: "judge" },
						},
					});
					const unit = actor.getSnapshot().children["unit:A"]?.getSnapshot();
					expect(unit?.value).toBe("stuck");
					expect(unit?.context.stuck).toMatchObject({
						episode: 1,
						reason: "unsupported-intervention-phase",
					});
					expect(unit?.children.task).toBeUndefined();
					yield* sendAndAwait(actor, {
						type: "unit.decide",
						unitId: "A",
						episode: 1,
						decision: { kind: "resume", phase: "judge" },
					});
					expect(
						actor.getSnapshot().children["unit:A"]?.getSnapshot().value,
					).toBe("stuck");
					yield* sendAndAwait(actor, {
						type: "unit.decide",
						unitId: "A",
						episode: 1,
						decision: { kind: "resume", phase: "verify" },
					});
					expect(
						actor.getSnapshot().children["unit:A"]?.getSnapshot().value,
					).toBe("verify");
					return;
				}
				yield* TestClock.adjust(10);
			}
			throw new Error("no human intervention");
		}).pipe(
			Effect.scoped,
			Effect.provideService(Workers, world.workers),
			Effect.provide(TestClock.layer()),
		),
	);
});

test("unit read computes transitive cancel preview and unfinished dependencies", async () => {
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
			for (const event of [
				add("A"),
				add("B", ["A"]),
				add("C", ["B"]),
				add("D", ["A", "C"]),
			])
				yield* sendAndAwait(actor, event);
			for (let i = 0; i < 20; i++) {
				const units = readUnits(actor.getSnapshot());
				if (units.find((unit) => unit.id === "A")?.task?.state === "asking") {
					expect(units.find((unit) => unit.id === "A")?.cancelCascade).toEqual([
						"B",
						"C",
						"D",
					]);
					expect(units.find((unit) => unit.id === "D")?.dependencies).toEqual([
						"A",
						"C",
					]);
					return;
				}
				yield* TestClock.adjust(10);
			}
			throw new Error("no human intervention");
		}).pipe(
			Effect.scoped,
			Effect.provideService(Workers, world.workers),
			Effect.provide(TestClock.layer()),
		),
	);
});

test("unit reads omit passed dependencies while retaining unfinished ones", async () => {
	const world = createWorld((input) => ({
		duration: 10,
		event: input.spec.taskId.startsWith("C/")
			? {
					type: "runner.report",
					outcome: { kind: "failed", detail: "blocked" },
				}
			: {
					type: "runner.report",
					outcome: {
						kind: "done",
						verdict: input.spec.phase === "implement" ? "done" : "pass",
						detail: "done",
					},
				},
	}));
	await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(workspace);
			for (const event of [add("A"), add("C"), add("B", ["A", "C"])])
				yield* sendAndAwait(actor, event);
			for (let i = 0; i < 30; i++) {
				const units = readUnits(actor.getSnapshot());
				if (
					units.find((unit) => unit.id === "A")?.verdict === "passed" &&
					units.find((unit) => unit.id === "C")?.task?.state === "asking"
				) {
					expect(units.find((unit) => unit.id === "B")?.dependencies).toEqual([
						"C",
					]);
					return;
				}
				yield* TestClock.adjust(10);
			}
			throw new Error("expected passed and unfinished dependencies");
		}).pipe(
			Effect.scoped,
			Effect.provideService(Workers, world.workers),
			Effect.provide(TestClock.layer()),
		),
	);
});
