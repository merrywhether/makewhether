import { createEffectActor, sendAndAwait } from "@xstate/effect";
import { Clock, Effect, References } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { Workers } from "../src/runner.ts";
import { readUnits, workspace } from "../src/workspace.ts";
import { makeRoutes, script } from "./scenario.ts";
import { createWorld } from "./workers.ts";

test("three units handle quota, model fallback, rework and a person", async () => {
	const world = createWorld(script);
	const processes = world.processes;
	let reminders = 0;
	let answerAt: number | undefined;
	const result = await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(workspace);
			actor.inspect((event) => {
				if (
					event.type === "@xstate.transition" &&
					event.event.type === "xstate.timer" &&
					event.event.event?.type === "xstate.after" &&
					event.event.event.stateId === "task.asking"
				)
					reminders++;
			});
			yield* sendAndAwait(actor, {
				type: "hold.add",
				hold: {
					id: "model",
					scope: { kind: "model", account: "pro", model: "first" },
					mode: "hard",
				},
			});
			for (const id of ["A", "B", "C"]) {
				yield* sendAndAwait(actor, {
					type: "unit.add",
					id,
					repo: id,
					title: id,
					deps: id === "C" ? ["A"] : [],
					routes: makeRoutes(id === "B"),
					maxRounds: 2,
					interventionCap: 2,
					attemptLimit: 2,
				});
			}
			for (let step = 0; step < 1500; step++) {
				// Let child notifications settle before inspecting the whole tree.
				yield* Effect.promise(
					() => new Promise<void>((resolve) => setImmediate(resolve)),
				);
				const unaccounted = readUnits(actor.getSnapshot()).filter(
					(unit) =>
						!unit.verdict &&
						!unit.task &&
						unit.dependencies.length === 0 &&
						unit.holds.length === 0,
				);
				expect(unaccounted).toEqual([]);
				const unit = actor.getSnapshot().children["unit:C"];
				const current = unit?.getSnapshot().children.task?.getSnapshot();
				if (current?.value === "asking") {
					const now = yield* Clock.currentTimeMillis;
					answerAt ??= now + 3 * 3_600_000;
					if (now >= answerAt) {
						yield* sendAndAwait(actor, {
							type: "task.answer",
							taskId: current.context.spec.taskId,
							outcome: {
								kind: "done",
								verdict: "decision",
								decision: { kind: "raise-limit", phase: "judge" },
							},
						});
					}
				}
				if (Object.keys(actor.getSnapshot().context.finished).length === 3)
					return actor.getSnapshot().context.finished;
				yield* TestClock.adjust(10_000);
			}
			throw new Error("scenario did not finish");
		}).pipe(
			Effect.scoped,
			Effect.provideService(Workers, world.workers),
			Effect.provide(TestClock.layer()),
			Effect.provideService(References.MinimumLogLevel, "Warn"),
		),
	);
	expect(result).toEqual({ A: "passed", B: "passed", C: "passed" });
	const get = (prefix: string) => {
		const process = processes.find((item) => item.input.key.startsWith(prefix));
		if (!process) throw new Error(`missing ${prefix}`);
		return process;
	};
	const a = get("A/1.implement.implementer#1");
	const b = get("B/1.implement.implementer#1");
	expect(b.input.worker.model).toBe("second");
	expect(b.stopped).toBe(a.ended);
	for (const id of ["A", "B"]) {
		const before = get(`${id}/1.implement.implementer#1`);
		const after = get(`${id}/1.implement.implementer#2`);
		expect(after.input.resume).toBe(before.session);
		expect(after.started - a.ended).toBeGreaterThanOrEqual(30_000);
	}
	expect(get("C/1.implement").started).toBeGreaterThanOrEqual(
		get("A/3.judge").ended,
	);
	expect(
		processes.filter(
			(item) =>
				item.input.spec.taskId.startsWith("B/") &&
				item.input.spec.phase === "implement",
		),
	).toHaveLength(3);
	expect(reminders).toBe(1);
});
