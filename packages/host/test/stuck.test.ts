import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getUnitSettings } from "@makewhether/config";
import type {
	InboxCommand,
	RunnerEvent,
	RunnerInput,
} from "@makewhether/domain";
import { Workers } from "@makewhether/machines";
import { openStore } from "@makewhether/store";
import { Effect } from "effect";
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
				const snapshot = engine.actor
					.getSnapshot()
					.children["unit:A"]?.getSnapshot();
				expect(snapshot?.value).toBe("intervene");
				expect(snapshot?.children.task?.getSnapshot().value).toBe("running");
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
					expect(
						engine.actor.getSnapshot().children["unit:A"]?.getSnapshot(),
					).toMatchObject({
						value: "stuck",
						context: { stuck: { episode: 1, reason: "invalid-final-tier" } },
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
