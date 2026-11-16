import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getUnitSettings } from "@makewhether/config";
import type {
	InboxCommand,
	RunnerEvent,
	RunnerInput,
} from "@makewhether/domain";
import { readUnits, Workers } from "@makewhether/machines";
import { openStore } from "@makewhether/store";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { openEngine } from "../src/engine.ts";

const add = {
	type: "unit.add",
	id: "A",
	brief: "work",
	machine: "unit",
	repo: "repo",
	dependencies: [],
} as const;
const unsure = {
	kind: "done",
	verdict: "unsure",
	detail: "person cannot decide",
} as const;

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "makew-stuck-"));
	const store = openStore(join(dir, "makew.db"));
	const inbox = join(dir, "inbox");
	return {
		store,
		inbox,
		write(key: string, command: InboxCommand) {
			writeFileSync(join(inbox, `${key}.json`), JSON.stringify(command));
		},
		close() {
			store.close();
			rmSync(dir, { force: true, recursive: true });
		},
	};
}

const failedImplement = {
	run: (_input: RunnerInput, emit: (event: RunnerEvent) => void) =>
		Effect.sync(() => emit({ type: "runner.report", outcome: unsure })),
};

test.each(["unit", "small-unit"])(
	"%s recovers only the current stuck episode",
	async (machine) => {
		const data = fixture();
		const { store, write } = data;
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const engine = yield* openEngine(data);
					const read = () => readUnits(engine.actor.getSnapshot());
					const find = () => read().find(({ id }) => id === "A");
					const answerUnsure = (key: string) =>
						Effect.gen(function* () {
							const taskId = find()?.task?.id;
							if (!taskId) throw new Error("missing person task");
							write(key, { type: "task.answer", taskId, outcome: unsure });
							yield* engine.drain;
						});
					write("01", { ...add, machine });
					write("02", { ...add, id: "B", dependencies: ["A"] });
					write("03", { ...add, id: "C", dependencies: ["B"] });
					yield* engine.drain;
					yield* answerUnsure("04");
					expect(find()).toMatchObject({
						status: "stuck",
						stuck: {
							episode: 1,
							reason: "unhandled-intervention",
							outcome: unsure,
						},
						cancelCascade: ["B", "C"],
					});
					expect(find()?.task).toBeUndefined();
					expect(find()?.verdict).toBeUndefined();

					const hold = { kind: "all" } as const;
					write("05", {
						type: "hold.add",
						kind: "pause",
						scope: hold,
						mode: "hard",
					});
					write("06", {
						type: "unit.decide",
						unitId: "A",
						episode: 1,
						decision: { kind: "resume" },
					});
					yield* engine.drain;
					expect(find()?.stuck).toBeUndefined();
					expect(find()?.holds.map(({ id }) => id)).toEqual(["05"]);

					write("07", { type: "hold.lift", holdId: "05" });
					yield* engine.drain;
					yield* answerUnsure("08");
					expect(find()?.stuck?.episode).toBe(2);
					write("06", {
						type: "unit.decide",
						unitId: "A",
						episode: 2,
						decision: { kind: "cancel" },
					});
					write("09", {
						type: "unit.decide",
						unitId: "A",
						episode: 1,
						decision: { kind: "cancel" },
					});
					if (machine === "small-unit")
						write("10", {
							type: "unit.decide",
							unitId: "A",
							episode: 2,
							decision: { kind: "resume", phase: "judge" },
						});
					yield* engine.drain;
					expect(find()?.stuck?.episode).toBe(2);
					expect(
						store.getAudit().filter(({ key }) => key === "06"),
					).toHaveLength(1);
					expect(
						store.getAudit().find(({ key }) => key === "09"),
					).toMatchObject({
						kind: "rejected",
						event: expect.stringContaining("stuck episode mismatch"),
					});
					if (machine === "small-unit")
						expect(
							store.getAudit().find(({ key }) => key === "10"),
						).toMatchObject({
							kind: "rejected",
							event: expect.stringContaining("unsupported decision phase"),
						});
					expect(
						store.getAudit().filter(({ event }) => JSON.parse(event).stuck),
					).toHaveLength(2);

					write("11", {
						type: "unit.decide",
						unitId: "A",
						episode: 2,
						decision: { kind: "cancel" },
					});
					write("12", { ...add, id: "D", dependencies: ["C"] });
					yield* engine.drain;
					expect(
						read().map(({ id, verdict, reason }) => [id, verdict, reason]),
					).toEqual([
						["A", "cancelled", undefined],
						["B", "cancelled", "A"],
						["C", "cancelled", "B"],
						["D", "cancelled", "C"],
					]);
				}).pipe(
					Effect.scoped,
					Effect.provideService(Workers, failedImplement),
					Effect.provide(TestClock.layer()),
				),
			);
		} finally {
			data.close();
		}
	},
);

test("restore parks a formerly running invalid final-tier worker before boot", async () => {
	const data = fixture();
	const { store, write } = data;
	const calls: string[] = [];
	const workers = {
		run: (input: RunnerInput, emit: (event: RunnerEvent) => void) =>
			Effect.gen(function* () {
				calls.push(input.key);
				if (input.spec.phase === "intervene") return yield* Effect.never;
				emit({ type: "runner.report", outcome: unsure });
			}),
	};
	const run = <A, E>(program: Effect.Effect<A, E, Workers>) =>
		Effect.runPromise(program.pipe(Effect.provideService(Workers, workers)));
	try {
		const settings = getUnitSettings();
		await run(
			Effect.gen(function* () {
				const engine = yield* openEngine({
					...data,
					resolveSettings: () => ({
						...settings,
						routes: {
							...settings.routes,
							intervene: [
								settings.routes.implement[0],
								...settings.routes.intervene,
							],
						},
					}),
				});
				write("01", add);
				yield* engine.drain;
				expect(readUnits(engine.actor.getSnapshot())[0]?.task).toMatchObject({
					state: "running",
					phase: "intervene",
				});
			}).pipe(Effect.scoped),
		);
		const checkpoint = store.getCheckpoint();
		if (!checkpoint) throw new Error("missing checkpoint");
		const saved = JSON.parse(checkpoint.snapshot);
		const unit = saved.children["unit:A"].snapshot;
		const before = calls.length;
		// The two saved task IDs agree, but identify a different run.
		const wrongTask = JSON.parse(checkpoint.snapshot);
		const wrongUnit = wrongTask.children["unit:A"].snapshot;
		wrongUnit.stateInputs["unit.intervene"].taskId = "other/2.intervene.fake";
		wrongUnit.children.task.snapshot.context.spec.taskId =
			"other/2.intervene.fake";
		store.commit({ ...checkpoint, snapshot: JSON.stringify(wrongTask) }, []);
		await run(
			Effect.gen(function* () {
				const engine = yield* openEngine(data);
				expect(
					engine.actor.getSnapshot().children["unit:A"]?.getSnapshot(),
				).toMatchObject({
					value: "stuck",
					context: { stuck: { episode: 1, reason: "invalid-task-state" } },
				});
			}).pipe(Effect.scoped),
		);
		expect(calls).toHaveLength(before);

		unit.context.routes.intervene.pop();
		store.commit({ ...checkpoint, snapshot: JSON.stringify(saved) }, []);
		for (let boot = 0; boot < 2; boot++) {
			await run(
				Effect.gen(function* () {
					const engine = yield* openEngine(data);
					expect(readUnits(engine.actor.getSnapshot())[0]).toMatchObject({
						status: "stuck",
						stuck: { episode: 1, reason: "invalid-final-tier" },
					});
					expect(
						engine.actor.getSnapshot().children["unit:A"]?.getSnapshot()
							.children,
					).toEqual({});
				}).pipe(Effect.scoped),
			);
		}
		expect(calls).toHaveLength(before);
		expect(
			store
				.getAudit()
				.filter(
					({ event }) =>
						JSON.parse(event).type === "unit.parked" &&
						JSON.parse(event).stuck.reason === "invalid-final-tier",
				),
		).toHaveLength(1);

		unit.machine.version = "old";
		store.commit({ ...checkpoint, snapshot: JSON.stringify(saved) }, []);
		await expect(run(openEngine(data).pipe(Effect.scoped))).rejects.toThrow(
			"cannot restore workspace/unit:A: incompatible unit checkpoint",
		);
		unit.machine.version = "1";

		unit.context.round = "unreadable";
		store.commit({ ...checkpoint, snapshot: JSON.stringify(saved) }, []);
		await expect(run(openEngine(data).pipe(Effect.scoped))).rejects.toThrow(
			"cannot restore unit A: invalid unit context",
		);
		saved.context.units = [];
		store.commit({ ...checkpoint, snapshot: JSON.stringify(saved) }, []);
		await expect(run(openEngine(data).pipe(Effect.scoped))).rejects.toThrow(
			"cannot restore workspace/unit:A: missing unit registration",
		);
		expect(calls).toHaveLength(before);
	} finally {
		data.close();
	}
});

test("a queued unit parked at restore still waits on and cancels with its dependency", async () => {
	const data = fixture();
	const { store, write } = data;
	const calls: string[] = [];
	const workers = {
		run: (input: RunnerInput) =>
			Effect.gen(function* () {
				calls.push(input.key);
				return yield* Effect.never;
			}),
	};
	const run = <A, E>(program: Effect.Effect<A, E, Workers>) =>
		Effect.runPromise(program.pipe(Effect.provideService(Workers, workers)));
	try {
		await run(
			Effect.gen(function* () {
				const engine = yield* openEngine(data);
				write("01", add);
				write("02", { ...add, id: "B", dependencies: ["A"] });
				yield* engine.drain;
			}).pipe(Effect.scoped),
		);
		const checkpoint = store.getCheckpoint();
		if (!checkpoint) throw new Error("missing checkpoint");
		const saved = JSON.parse(checkpoint.snapshot);
		for (const id of ["A", "B"]) {
			const { routes } = saved.children[`unit:${id}`].snapshot.context;
			routes.intervene = routes.implement;
		}
		store.commit({ ...checkpoint, snapshot: JSON.stringify(saved) }, []);
		await run(
			Effect.gen(function* () {
				const engine = yield* openEngine(data);
				write("03", {
					type: "unit.decide",
					unitId: "B",
					episode: 1,
					decision: { kind: "resume" },
				});
				yield* engine.drain;
				expect(store.getAudit().find(({ key }) => key === "03")).toMatchObject({
					kind: "rejected",
					event: expect.stringContaining(
						"unit dependencies are unfinished or cancelled",
					),
				});
				expect(
					engine.actor.getSnapshot().children["unit:B"]?.getSnapshot().value,
				).toBe("stuck");

				write("04", {
					type: "unit.decide",
					unitId: "A",
					episode: 1,
					decision: { kind: "cancel" },
				});
				yield* engine.drain;
				const { finished, cancellationReasons } =
					engine.actor.getSnapshot().context;
				expect(finished).toEqual({ A: "cancelled", B: "cancelled" });
				expect(cancellationReasons).toEqual({ B: "A" });
			}).pipe(Effect.scoped),
		);
		expect(calls).toEqual(["A/1.implement.fake#1"]);
	} finally {
		data.close();
	}
});
