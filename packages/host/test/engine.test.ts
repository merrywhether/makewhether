import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getUnitSettings } from "@makewhether/config";
import { Workers } from "@makewhether/machines";
import { createFakeWorkers } from "@makewhether/runner";
import { openStore } from "@makewhether/store";
import { waitFor } from "@xstate/effect";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { createWorld } from "../../machines/test/workers.ts";
import { openEngine } from "../src/engine.ts";

const add = {
	type: "unit.add",
	id: "U",
	brief: "brief",
	machine: "unit",
	repo: "repo",
	dependencies: [],
};

test("drains complete commands once and preserves rejected artifacts", async () => {
	const dir = mkdtempSync(join(tmpdir(), "makew-engine-"));
	const inbox = join(dir, "inbox");
	const store = openStore(join(dir, "store.db"));
	const workers = createFakeWorkers();
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const settings = getUnitSettings();
				const implement = settings.routes.implement[0];
				const engine = yield* openEngine({
					inbox,
					store,
					resolveSettings: () => ({
						...settings,
						routes: {
							...settings.routes,
							implement: [
								{ ...implement, effort: "high", timeLimitMs: 60_000 },
							],
						},
					}),
				});
				writeFileSync(join(inbox, ".temporary.json"), "{");
				writeFileSync(join(inbox, "one.json"), JSON.stringify(add));
				writeFileSync(join(inbox, "bad.json"), "{");
				yield* engine.drain;
				expect(
					engine.actor.getSnapshot().context.units.map((unit) => unit.id),
				).toEqual(["U"]);
				expect(store.getDisposition("one")).toBe("accepted");
				expect(store.getDisposition(".temporary")).toBeUndefined();
				expect(existsSync(join(inbox, ".temporary.json"))).toBe(true);
				expect(store.getDisposition("bad")).toBe("rejected");
				expect(readFileSync(join(inbox, "rejected", "bad.json"), "utf8")).toBe(
					"{",
				);
				writeFileSync(join(inbox, "one.json"), JSON.stringify(add));
				writeFileSync(join(inbox, "bad.json"), "replacement");
				writeFileSync(join(inbox, "duplicate.json"), JSON.stringify(add));
				writeFileSync(
					join(inbox, "unknown-machine.json"),
					JSON.stringify({ ...add, id: "X", machine: "missing" }),
				);
				writeFileSync(
					join(inbox, "unknown-hold.json"),
					JSON.stringify({ type: "hold.lift", holdId: "missing" }),
				);
				writeFileSync(
					join(inbox, "stale-answer.json"),
					JSON.stringify({
						type: "task.answer",
						taskId: "old",
						outcome: {
							kind: "done",
							verdict: "decision",
							decision: { kind: "cancel" },
						},
					}),
				);
				yield* engine.drain;
				for (const key of [
					"duplicate",
					"unknown-machine",
					"unknown-hold",
					"stale-answer",
				])
					expect(store.getDisposition(key)).toBe("rejected");
				expect(readFileSync(join(inbox, "rejected", "bad.json"), "utf8")).toBe(
					"{",
				);
				expect(
					store
						.getAudit()
						.filter((entry) => entry.kind === "inbox" && entry.key === "one"),
				).toHaveLength(1);
				workers.openGate();
				yield* waitFor(
					engine.actor,
					(state) => state.context.finished.U === "passed",
				);
				yield* Effect.promise(
					() => new Promise<void>((resolve) => setImmediate(resolve)),
				);
				const starts = store
					.getAudit()
					.filter((entry) => entry.event.includes('"type":"runner.started"'));
				expect(starts.length).toBeGreaterThan(0);
				expect(JSON.parse(starts[0]?.event ?? "{}")).toMatchObject({
					taskId: "U/1.implement.fake",
					tier: "fake",
					worker: { model: "fake", harness: "codex", account: "fake" },
					effort: "high",
					timeLimitMs: 60_000,
				});
				engine.close();
			}).pipe(Effect.scoped, Effect.provideService(Workers, workers)),
		);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("boot drains a hard pause before opening the worker gate", async () => {
	const dir = mkdtempSync(join(tmpdir(), "makew-engine-"));
	const inbox = join(dir, "inbox");
	const store = openStore(join(dir, "store.db"));
	try {
		const firstWorkers = createFakeWorkers();
		await Effect.runPromise(
			Effect.gen(function* () {
				const engine = yield* openEngine({ inbox, store });
				writeFileSync(join(inbox, "one.json"), JSON.stringify(add));
				yield* engine.drain;
				engine.close();
			}).pipe(Effect.scoped, Effect.provideService(Workers, firstWorkers)),
		);
		writeFileSync(
			join(inbox, "pause.json"),
			JSON.stringify({
				type: "hold.add",
				kind: "pause",
				mode: "hard",
				scope: { kind: "all" },
			}),
		);
		const workers = createFakeWorkers();
		await Effect.runPromise(
			Effect.gen(function* () {
				const engine = yield* openEngine({ inbox, store });
				yield* engine.drain;
				workers.openGate();
				yield* Effect.promise(
					() => new Promise<void>((resolve) => setImmediate(resolve)),
				);
				const task = engine.actor
					.getSnapshot()
					.children["unit:U"]?.getSnapshot()
					.children.task?.getSnapshot();
				expect(task?.value).toBe("held");
				expect(
					store
						.getAudit()
						.filter((entry) => entry.event.includes('"type":"runner.started"')),
				).toHaveLength(0);
				engine.close();
			}).pipe(Effect.scoped, Effect.provideService(Workers, workers)),
		);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("boot refuses a mismatched root or a failed child restore", async () => {
	const dir = mkdtempSync(join(tmpdir(), "makew-restore-"));
	const inbox = join(dir, "inbox");
	const store = openStore(join(dir, "store.db"));
	const workers = createFakeWorkers();
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const engine = yield* openEngine({ inbox, store });
				writeFileSync(join(inbox, "one.json"), JSON.stringify(add));
				yield* engine.drain;
				engine.close();
			}).pipe(Effect.scoped, Effect.provideService(Workers, workers)),
		);
		const checkpoint = store.getCheckpoint();
		if (!checkpoint) throw new Error("missing checkpoint");
		store.commit({ ...checkpoint, version: "other" }, []);
		await expect(
			Effect.runPromise(
				openEngine({ inbox, store }).pipe(
					Effect.scoped,
					Effect.provideService(Workers, createFakeWorkers()),
				),
			),
		).rejects.toThrow("checkpoint workspace@other");
		const snapshot: unknown = JSON.parse(checkpoint.snapshot);
		const children = getRecord(getRecord(snapshot).children);
		const unit = getRecord(getRecord(children["unit:U"]).snapshot);
		getRecord(unit.machine).version = "old";
		store.commit({ ...checkpoint, snapshot: JSON.stringify(snapshot) }, []);
		await expect(
			Effect.runPromise(
				openEngine({ inbox, store }).pipe(
					Effect.scoped,
					Effect.provideService(Workers, createFakeWorkers()),
				),
			),
		).rejects.toThrow("workspace/unit:U");
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

function getRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value == null || Array.isArray(value))
		throw new Error("expected object");
	return value as Record<string, unknown>;
}

test("an interrupted inbox capture replays its unconsumed command", async () => {
	const dir = mkdtempSync(join(tmpdir(), "makew-capture-"));
	const inbox = join(dir, "inbox");
	const store = openStore(join(dir, "store.db"));
	try {
		const workers = createFakeWorkers();
		await expect(
			Effect.runPromise(
				Effect.gen(function* () {
					const engine = yield* openEngine({
						inbox,
						store,
						captureHook: (point) => {
							if (point === "after-send") throw new Error("injected crash");
						},
					});
					writeFileSync(join(inbox, "one.json"), JSON.stringify(add));
					yield* engine.drain;
				}).pipe(Effect.scoped, Effect.provideService(Workers, workers)),
			),
		).rejects.toThrow("injected crash");
		expect(store.getDisposition("one")).toBeUndefined();
		expect(store.getCheckpoint()?.snapshot).not.toContain('"id":"U"');
		const restarted = createFakeWorkers();
		await Effect.runPromise(
			Effect.gen(function* () {
				const engine = yield* openEngine({ inbox, store });
				yield* engine.drain;
				expect(
					engine.actor.getSnapshot().context.units.map((unit) => unit.id),
				).toEqual(["U"]);
				expect(store.getDisposition("one")).toBe("accepted");
			}).pipe(Effect.scoped, Effect.provideService(Workers, restarted)),
		);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("boot finishes archiving a rejection committed before a crash", async () => {
	const dir = mkdtempSync(join(tmpdir(), "makew-rejection-"));
	const inbox = join(dir, "inbox");
	const store = openStore(join(dir, "store.db"));
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const engine = yield* openEngine({ inbox, store });
				const checkpoint = store.getCheckpoint();
				if (!checkpoint) throw new Error("missing checkpoint");
				store.commit(
					checkpoint,
					[
						{
							at: 1,
							kind: "rejected",
							key: "bad",
							event: "{}",
							address: "workspace",
						},
					],
					{ key: "bad", at: 1, disposition: "rejected" },
				);
				writeFileSync(join(inbox, "bad.json"), "original invalid data");
				yield* engine.drain;
				expect(readFileSync(join(inbox, "rejected", "bad.json"), "utf8")).toBe(
					"original invalid data",
				);
				writeFileSync(join(inbox, "bad.json"), "replacement");
				yield* engine.drain;
				expect(readFileSync(join(inbox, "rejected", "bad.json"), "utf8")).toBe(
					"original invalid data",
				);
			}).pipe(
				Effect.scoped,
				Effect.provideService(Workers, createFakeWorkers()),
			),
		);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a worker completed before delivery is replayed after an injected crash", async () => {
	const dir = mkdtempSync(join(tmpdir(), "makew-worker-crash-"));
	const inbox = join(dir, "inbox");
	const store = openStore(join(dir, "store.db"));
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
	let suppress = true;
	let blocked = false;
	const workers: typeof Workers.Service = {
		run: (input, emit) =>
			Effect.gen(function* () {
				let delayed = false;
				yield* world.workers.run(input, (event) => {
					if (suppress && event.type === "runner.report") {
						delayed = true;
						blocked = true;
					} else emit(event);
				});
				if (delayed) yield* Effect.never;
			}),
	};
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* Effect.gen(function* () {
					const engine = yield* openEngine({ inbox, store });
					writeFileSync(join(inbox, "one.json"), JSON.stringify(add));
					yield* engine.drain;
					yield* TestClock.adjust(10);
					expect(blocked).toBe(true);
					expect(engine.actor.getSnapshot().context.finished.U).toBeUndefined();
					world.crashing = true;
				}).pipe(Effect.scoped);
				world.crashing = false;
				suppress = false;
				const engine = yield* openEngine({ inbox, store });
				for (
					let step = 0;
					step < 20 &&
					engine.actor.getSnapshot().context.finished.U !== "passed";
					step++
				)
					yield* TestClock.adjust(10);
				expect(engine.actor.getSnapshot().context.finished.U).toBe("passed");
			}).pipe(
				Effect.scoped,
				Effect.provideService(Workers, workers),
				Effect.provide(TestClock.layer()),
			),
		);
		expect(world.calls.some((call) => call.mode === "replay")).toBe(true);
		expect(
			world.processes.filter(
				(process) => process.input.spec.phase === "implement",
			),
		).toHaveLength(1);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an actor that stops before capture does not consume the command or replace the checkpoint", async () => {
	const dir = mkdtempSync(join(tmpdir(), "makew-actor-error-"));
	const inbox = join(dir, "inbox");
	const store = openStore(join(dir, "store.db"));
	let stop = () => {};
	try {
		await expect(
			Effect.runPromise(
				Effect.gen(function* () {
					const engine = yield* openEngine({
						inbox,
						store,
						captureHook: (point) => {
							if (point === "after-send") stop();
						},
					});
					stop = () => {
						engine.actor.stop();
					};
					writeFileSync(join(inbox, "one.json"), JSON.stringify(add));
					yield* engine.drain;
				}).pipe(
					Effect.scoped,
					Effect.provideService(Workers, createFakeWorkers()),
				),
			),
		).rejects.toThrow();
		expect(store.getDisposition("one")).toBeUndefined();
		expect(store.getCheckpoint()?.snapshot).not.toContain('"id":"U"');
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("configuration failures leave the inbox command unconsumed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "makew-config-error-"));
	const inbox = join(dir, "inbox");
	const store = openStore(join(dir, "store.db"));
	try {
		await expect(
			Effect.runPromise(
				Effect.gen(function* () {
					const engine = yield* openEngine({
						inbox,
						store,
						resolveSettings: () => {
							throw new Error("configuration unavailable");
						},
					});
					writeFileSync(join(inbox, "one.json"), JSON.stringify(add));
					yield* engine.drain;
				}).pipe(
					Effect.scoped,
					Effect.provideService(Workers, createFakeWorkers()),
				),
			),
		).rejects.toThrow("configuration unavailable");
		expect(store.getDisposition("one")).toBeUndefined();
		expect(readFileSync(join(inbox, "one.json"), "utf8")).toBe(
			JSON.stringify(add),
		);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("boot lets a live record reattach while a new start waits for the inbox pause", async () => {
	const dir = mkdtempSync(join(tmpdir(), "makew-gate-world-"));
	const inbox = join(dir, "inbox");
	const store = openStore(join(dir, "store.db"));
	let releaseGate = () => {};
	const gate = new Promise<void>((resolve) => {
		releaseGate = resolve;
	});
	let allowFirst = true;
	const world = createWorld(
		() => ({
			duration: 100_000,
			event: {
				type: "runner.report",
				outcome: { kind: "done", verdict: "done", detail: "done" },
			},
		}),
		{
			waitForStart: (input) =>
				allowFirst && input.spec.taskId.startsWith("A/")
					? Effect.void
					: Effect.promise(() => gate),
		},
	);
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* Effect.gen(function* () {
					const engine = yield* openEngine({ inbox, store });
					writeFileSync(
						join(inbox, "a.json"),
						JSON.stringify({ ...add, id: "A" }),
					);
					writeFileSync(
						join(inbox, "b.json"),
						JSON.stringify({ ...add, id: "B" }),
					);
					yield* engine.drain;
					yield* TestClock.adjust(1);
					expect(
						world.processes.map(
							(process) => process.input.spec.taskId.split("/")[0],
						),
					).toEqual(["A"]);
					world.crashing = true;
				}).pipe(Effect.scoped);
				world.crashing = false;
				allowFirst = false;
				writeFileSync(
					join(inbox, "pause.json"),
					JSON.stringify({
						type: "hold.add",
						kind: "pause",
						mode: "hard",
						scope: { kind: "all" },
					}),
				);
				const engine = yield* openEngine({ inbox, store });
				for (
					let i = 0;
					i < 10 && !world.calls.some((call) => call.mode === "reattach");
					i++
				)
					yield* TestClock.adjust(1);
				expect(world.calls.some((call) => call.mode === "reattach")).toBe(true);
				expect(world.processes).toHaveLength(1);
				yield* engine.drain;
				releaseGate();
				yield* TestClock.adjust(1);
				for (const id of ["A", "B"])
					expect(
						engine.actor
							.getSnapshot()
							.children[`unit:${id}`]?.getSnapshot()
							.children.task?.getSnapshot().value,
					).toBe("held");
				expect(world.processes).toHaveLength(1);
			}).pipe(
				Effect.scoped,
				Effect.provideService(Workers, world.workers),
				Effect.provide(TestClock.layer()),
			),
		);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the inbox transaction captures child completion and dependent progress", async () => {
	const dir = mkdtempSync(join(tmpdir(), "makew-settle-"));
	const inbox = join(dir, "inbox");
	const store = openStore(join(dir, "store.db"));
	let captured: string | undefined;
	const tracked: typeof store = {
		...store,
		commit(checkpoint, entries, consumed) {
			store.commit(checkpoint, entries, consumed);
			if (consumed?.key === "answer") captured = checkpoint.snapshot;
		},
	};
	const settings = getUnitSettings();
	const person = {
		harness: "person",
		model: "person",
		account: "person",
	} as const;
	const resolveSettings = () => ({
		...settings,
		routes: {
			...settings.routes,
			judge: [
				{ tier: "person", workers: [person] as const, rules: {} },
			] as const,
		},
	});
	const workers = createFakeWorkers();
	workers.openGate();
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const engine = yield* openEngine({
					inbox,
					store: tracked,
					resolveSettings,
				});
				writeFileSync(
					join(inbox, "a-D.json"),
					JSON.stringify({ ...add, id: "D" }),
				);
				writeFileSync(
					join(inbox, "b-E.json"),
					JSON.stringify({ ...add, id: "E", dependencies: ["D"] }),
				);
				yield* engine.drain;
				let taskId: string | undefined;
				for (let index = 0; index < 100 && taskId === undefined; index++) {
					const task = engine.actor
						.getSnapshot()
						.children["unit:D"]?.getSnapshot()
						.children.task?.getSnapshot();
					if (task?.value === "asking") taskId = task.context.spec.taskId;
					else
						yield* Effect.promise(
							() => new Promise<void>((resolve) => setImmediate(resolve)),
						);
				}
				if (!taskId) throw new Error("D did not reach its person judge");
				writeFileSync(
					join(inbox, "answer.json"),
					JSON.stringify({
						type: "task.answer",
						taskId,
						outcome: { kind: "done", verdict: "pass", detail: "approved" },
					}),
				);
				yield* engine.drain;
				if (!captured) throw new Error("answer was not committed");
				const root: unknown = JSON.parse(captured);
				const rootRecord = getRecord(root);
				const context = getRecord(rootRecord.context);
				expect(getRecord(context.finished).D).toBe("passed");
				const children = getRecord(rootRecord.children);
				const dependent = getRecord(getRecord(children["unit:E"]).snapshot);
				expect(dependent.value).not.toBe("queued");
			}).pipe(Effect.scoped, Effect.provideService(Workers, workers)),
		);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("archives cycle-closing commands and invalid unit IDs in rejected inbox", async () => {
	const dir = mkdtempSync(join(tmpdir(), "makew-engine-"));
	const inbox = join(dir, "inbox");
	const store = openStore(join(dir, "store.db"));
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const engine = yield* openEngine({ inbox, store });
				const commands = [
					{ key: "01-self", id: "Self", deps: ["Self"] },
					{ key: "02-first", id: "A", deps: ["B"] },
					{ key: "03-close", id: "B", deps: ["A"] },
					{ key: "04-invalid-id", id: "invalid.id", deps: [] },
					{ key: "05-invalid.key", id: undefined, deps: [] },
				];
				for (const { key, id, deps } of commands)
					writeFileSync(
						join(inbox, `${key}.json`),
						JSON.stringify({ ...add, id, dependencies: deps }),
					);
				yield* engine.drain;
				expect(store.getDisposition("02-first")).toBe("accepted");
				expect(
					engine.actor.getSnapshot().context.units.map(({ id }) => id),
				).toEqual(["A"]);
				for (const [key, error] of [
					["01-self", "dependency cycle for unit Self"],
					["03-close", "dependency cycle for unit B"],
					["04-invalid-id", "task ID components cannot contain"],
					["05-invalid.key", "unit ID cannot contain"],
				] as const) {
					expect(store.getDisposition(key)).toBe("rejected");
					expect(existsSync(join(inbox, "rejected", `${key}.json`))).toBe(true);
					expect(
						store.getAudit().find((entry) => entry.key === key)?.event,
					).toContain(error);
				}
			}).pipe(
				Effect.scoped,
				Effect.provideService(Workers, createFakeWorkers()),
			),
		);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
