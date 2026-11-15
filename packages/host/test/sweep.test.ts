import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getUnitSettings } from "@makewhether/config";
import { Workers } from "@makewhether/machines";
import {
	type Checkpoint,
	type LogEntry,
	openStore,
	type Store,
} from "@makewhether/store";
import { Clock, Effect, References } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { makeRoutes, script } from "../../machines/test/scenario.ts";
import { createWorld, type Process } from "../../machines/test/workers.ts";
import { openEngine } from "../src/engine.ts";

type Saved = {
	checkpoint: Checkpoint;
	consumed: readonly string[];
	processes: Process[];
};
type Baseline = {
	saved: Saved[];
	processes: Process[];
	end: number;
	answerAt: number;
	finished: Record<string, string>;
};
const commands = [
	[
		"0-model",
		{
			type: "hold.add",
			kind: "pause",
			mode: "hard",
			scope: { kind: "model", account: "pro", model: "first" },
		},
	],
	...["A", "B", "C"].map(
		(id) =>
			[
				`1-${id}`,
				{
					type: "unit.add",
					id,
					brief: id,
					machine: "unit",
					repo: id,
					dependencies: id === "C" ? ["A"] : [],
				},
			] as const,
	),
] as const;

function recordStore(
	store: Store,
	saved: Saved[],
	processes: Process[],
): Store {
	return {
		...store,
		commit(checkpoint: Checkpoint, entries: readonly LogEntry[], consumed) {
			store.commit(checkpoint, entries, consumed);
			const keys = store
				.getAudit()
				.filter((entry) => entry.kind === "inbox")
				.map((entry) => entry.key);
			const previous = saved.at(-1);
			if (
				!previous ||
				previous.checkpoint.snapshot !== checkpoint.snapshot ||
				JSON.stringify(previous.consumed) !== JSON.stringify(keys)
			)
				saved.push({
					checkpoint,
					consumed: keys,
					processes: processes.map((process) => ({ ...process })),
				});
		},
	};
}

async function drive(options: {
	saved?: Saved;
	processes?: Process[];
	now?: number;
	answerAt?: number;
	capture?: boolean;
}) {
	const dir = mkdtempSync(join(tmpdir(), "makew-sweep-"));
	const inbox = join(dir, "inbox");
	mkdirSync(inbox, { recursive: true });
	const store = openStore(":memory:");
	const world = createWorld(script);
	world.processes.push(
		...(options.processes ?? []).map((process) => ({ ...process })),
	);
	const saved: Saved[] = [];
	for (const [key, command] of commands)
		writeFileSync(join(inbox, `${key}.json`), JSON.stringify(command));
	if (options.saved) {
		for (const key of options.saved.consumed)
			store.commit(
				options.saved.checkpoint,
				[{ at: 0, kind: "inbox", key, event: "{}", address: "workspace" }],
				{ key, at: 0, disposition: "accepted" },
			);
		if (options.saved.consumed.length === 0)
			store.commit(options.saved.checkpoint, []);
	}
	let answerAt = options.answerAt;
	let answered = options.saved?.consumed.includes("4-answer") ?? false;
	try {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				if (options.now !== undefined) yield* TestClock.setTime(options.now);
				const engine = yield* openEngine({
					inbox,
					store: options.capture
						? recordStore(store, saved, world.processes)
						: store,
					resolveSettings: (command) => ({
						...getUnitSettings(),
						routes: makeRoutes(command.id === "B"),
					}),
				});
				yield* engine.drain;
				for (let step = 0; step < 1600; step++) {
					const current = engine.actor
						.getSnapshot()
						.children["unit:C"]?.getSnapshot()
						.children.task?.getSnapshot();
					if (current?.value === "asking" && !answered) {
						const now = yield* Clock.currentTimeMillis;
						answerAt ??= now + 3 * 3_600_000;
						if (now >= answerAt) {
							writeFileSync(
								join(inbox, "4-answer.json"),
								JSON.stringify({
									type: "task.answer",
									taskId: current.context.spec.taskId,
									outcome: {
										kind: "done",
										verdict: "decision",
										decision: { kind: "raise-limit", phase: "judge" },
									},
								}),
							);
							yield* engine.drain;
							answered = true;
						}
					}
					const finished = engine.actor.getSnapshot().context.finished;
					if (Object.keys(finished).length === 3) {
						yield* Effect.promise(
							() => new Promise<void>((resolve) => setImmediate(resolve)),
						);
						engine.close();
						return { finished, end: yield* Clock.currentTimeMillis };
					}
					yield* TestClock.adjust(10_000);
					yield* Effect.promise(
						() => new Promise<void>((resolve) => setImmediate(resolve)),
					);
				}
				throw new Error(
					`scenario did not finish: ${JSON.stringify(engine.actor.getSnapshot().context)} children=${JSON.stringify(Object.fromEntries(Object.entries(engine.actor.getSnapshot().children).map(([id, ref]) => [id, ref?.getSnapshot().value])))}`,
				);
			}).pipe(
				Effect.scoped,
				Effect.provideService(Workers, world.workers),
				Effect.provide(TestClock.layer()),
				Effect.provideService(References.MinimumLogLevel, "Warn"),
			),
		);
		return {
			...result,
			saved,
			processes: world.processes,
			answerAt: answerAt ?? 0,
		};
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

test("the host restores each three-unit checkpoint after three downtimes", async () => {
	const baseline: Baseline = await drive({ capture: true });
	expect(baseline.finished).toEqual({ A: "passed", B: "passed", C: "passed" });
	expect(baseline.saved.length).toBeGreaterThan(5);
	expect(
		baseline.saved.some(({ checkpoint }) =>
			checkpoint.snapshot.includes('"value":"held"'),
		),
	).toBe(true);
	expect(
		baseline.saved.some(({ checkpoint }) =>
			checkpoint.snapshot.includes('"value":"running"'),
		),
	).toBe(true);
	console.info(
		`Crash sweep: ${baseline.saved.length} checkpoints × 3 downtimes, including held and running tasks`,
	);
	for (let index = 0; index < baseline.saved.length; index++) {
		const saved = baseline.saved[index];
		if (!saved) throw new Error("missing checkpoint");
		const crashAt = saved.checkpoint.at;
		for (const downtime of [0, 45_000, 4 * 3_600_000]) {
			const processes = saved.processes.map((process) => ({ ...process }));
			let restored: Awaited<ReturnType<typeof drive>>;
			try {
				restored = await drive({
					saved,
					processes,
					now: crashAt + downtime,
					answerAt: baseline.answerAt,
				});
			} catch (error) {
				throw new Error(
					`checkpoint ${index} at ${saved.checkpoint.at}, crash ${crashAt}, downtime ${downtime}: ${String(error)}`,
				);
			}
			expect(
				new Set(restored.processes.map((item) => item.input.key)).size,
			).toBe(restored.processes.length);
			expect(
				restored.finished,
				`checkpoint ${index}, downtime ${downtime}`,
			).toEqual(baseline.finished);
			for (const process of processes)
				if (
					process.stopped === undefined &&
					process.ended <= crashAt + downtime
				)
					expect(
						restored.processes.filter(
							(item) => item.input.key === process.input.key,
						),
					).toHaveLength(1);
		}
	}
}, 120_000);
