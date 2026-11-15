import type { Routes, WorkerReport } from "@makewhether/domain";
import { createEffectActor, sendAndAwait } from "@xstate/effect";
import { Clock, Effect, References } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { Workers } from "../src/runner.ts";
import { workspace } from "../src/workspace.ts";
import { createWorld } from "./workers.ts";

const agent = { harness: "codex", model: "agent", account: "pro" } as const;
const first = { harness: "codex", model: "first", account: "pro" } as const;
const second = { harness: "codex", model: "second", account: "pro" } as const;
const shell = { harness: "shell", model: "shell", account: "local" } as const;
const person = {
	harness: "person",
	model: "person",
	account: "person",
} as const;
const makeRoutes = (fallback = false): Routes => ({
	implement: [
		{
			tier: "implementer",
			workers: fallback ? [first, second] : [agent],
			rules: {},
		},
	],
	verify: [{ tier: "script", workers: [shell], rules: {} }],
	judge: [{ tier: "judge", workers: [agent], rules: {} }],
	intervene: [
		{ tier: "agent", workers: [agent], rules: {} },
		{ tier: "person", workers: [person], rules: {} },
	],
});

const report = (
	verdict: "done" | "pass" | "findings" | "unsure",
): WorkerReport => ({
	kind: "done",
	verdict,
	detail: verdict,
});

test("three units handle quota, model fallback, rework and a person", async () => {
	const world = createWorld((input, prior, now) => {
		const unit = input.spec.taskId.split("/")[0];
		const limit =
			unit === "A" && input.spec.phase === "implement" && prior === 0;
		const duration = limit
			? 10_000
			: input.spec.phase === "implement"
				? 20_000
				: 10_000;
		if (limit)
			return {
				duration,
				event: {
					type: "runner.limit",
					holdId: "quota",
					scope: { kind: "account", account: "pro" },
					at: now + duration,
					resetsAt: now + duration + 30_000,
				},
			};
		const verdict =
			input.spec.phase === "implement"
				? "done"
				: input.spec.phase === "verify"
					? "pass"
					: input.spec.phase === "intervene"
						? "unsure"
						: (unit === "B" && prior === 0) || (unit === "C" && prior < 2)
							? "findings"
							: "pass";
		return {
			duration,
			event: { type: "runner.report", outcome: report(verdict) },
		};
	});
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
				});
			}
			for (let step = 0; step < 1500; step++) {
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
