import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	type RunnerEvent,
	type RunnerInput,
	WorkerReport,
} from "@makewhether/domain";
import { Workers, workspace } from "@makewhether/machines";
import { createEffectActor, sendAndAwait } from "@xstate/effect";
import { Clock, Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { machineVersions } from "xstate";
import { isLockOwnerAlive, readLock } from "./lock.ts";

const Timeline = Schema.Struct({
	type: Schema.Literals([
		"start",
		"answer",
		"reattach",
		"replay",
		"lost",
		"parked",
	]),
	key: Schema.String,
	at: Schema.Number,
});
const decodeTimeline = Schema.decodeUnknownSync(Timeline);
function lines(path: string): unknown[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}
function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value == null || Array.isArray(value))
		throw new Error("invalid recording object");
	return Object.fromEntries(Object.entries(value));
}
function recordingInput(path: string) {
	const db = new DatabaseSync(join(path, "makew.db"), { readOnly: true });
	try {
		const checkpoint = db
			.prepare(
				"SELECT machine, version, snapshot, at FROM checkpoint WHERE id = 1",
			)
			.get();
		if (
			!checkpoint ||
			typeof checkpoint.machine !== "string" ||
			typeof checkpoint.version !== "string" ||
			typeof checkpoint.snapshot !== "string" ||
			typeof checkpoint.at !== "number"
		)
			throw new Error("missing recording checkpoint");
		const entries = db
			.prepare("SELECT at, event FROM audit WHERE kind = 'inbox' ORDER BY seq")
			.all()
			.map((row) => {
				if (typeof row.at !== "number" || typeof row.event !== "string")
					throw new Error("invalid inbox history");
				return { at: row.at, event: JSON.parse(row.event) };
			});
		const transitions = db
			.prepare(
				"SELECT at,address,event FROM audit WHERE kind = 'transition' ORDER BY seq",
			)
			.all()
			.map((row) => {
				if (
					typeof row.at !== "number" ||
					typeof row.address !== "string" ||
					typeof row.event !== "string"
				)
					throw new Error("invalid transition history");
				return {
					at: row.at,
					address: row.address,
					event: object(JSON.parse(row.event)),
				};
			});
		return {
			checkpoint: {
				machine: checkpoint.machine,
				version: checkpoint.version,
				snapshot: checkpoint.snapshot,
				at: checkpoint.at,
			},
			entries,
			transitions,
		};
	} finally {
		db.close();
	}
}
function rejectLinks(directory: string): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isSymbolicLink())
			throw new Error(`recording contains a symbolic link: ${path}`);
		if (entry.isDirectory()) rejectLinks(path);
	}
}
function writableDirectories(directory: string): void {
	chmodSync(directory, 0o700);
	for (const entry of readdirSync(directory, { withFileTypes: true }))
		if (entry.isDirectory()) writableDirectories(join(directory, entry.name));
}
/** Replay a non-live recording in an isolated copy, using only its external events and records. */
export async function replay(recording: string, liveDir?: string) {
	const source = realpathSync(recording);
	const defaultDir = join(
		process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
		"makewhether",
	);
	const live = resolve(liveDir ?? process.env.MAKEW_DATA_DIR ?? defaultDir);
	if (existsSync(live) && realpathSync(live) === source)
		throw new Error("replay requires a copy of the data directory");
	rejectLinks(source);
	const owner = readLock(join(source, "engine.lock"));
	if (owner && isLockOwnerAlive(owner))
		throw new Error("cannot replay an active engine data directory");
	const temp = mkdtempSync(join(tmpdir(), "makew-replay-"));
	try {
		const copy = join(temp, "recording");
		cpSync(source, copy, { recursive: true });
		writableDirectories(copy);
		const { checkpoint, entries, transitions } = recordingInput(copy);
		const snapshot = object(JSON.parse(checkpoint.snapshot));
		const context = object(snapshot.context);
		const unitEntries = Array.isArray(context.units)
			? context.units.map(object)
			: [];
		const unitIds = unitEntries
			.map((unit) => unit.id)
			.filter((id): id is string => typeof id === "string");
		const unitForTask = (taskId: string) =>
			unitIds
				.filter((candidate) => taskId.startsWith(`${candidate}/`))
				.sort((a, b) => b.length - a.length)[0];
		const versions = machineVersions([workspace]);
		const events = await versions.adaptEvents(
			entries.map((row) => row.event),
			{
				from: { id: checkpoint.machine, version: checkpoint.version },
				to: workspace.version,
				adapters: {},
			},
		);
		if (events.length !== entries.length)
			throw new Error("event adaptation changed replay timing cardinality");
		const timelinePath = join(copy, "runs", "runs.jsonl");
		const timeline = existsSync(timelinePath)
			? lines(timelinePath).map((line) => decodeTimeline(line))
			: [];
		const starts = timeline.filter((entry) => entry.type === "start");
		const answers = timeline.filter((entry) => entry.type === "answer");
		const started: { key: string; at: number; resume?: string }[] = [];
		const answered: { key: string; at: number }[] = [];
		const used = new Set<string>();
		let replayError: Error | undefined;
		function fail(message: string): never {
			const error = new Error(message);
			replayError ??= error;
			throw error;
		}
		const workers = {
			run: (input: RunnerInput, emit: (event: RunnerEvent) => void) =>
				Effect.gen(function* () {
					const start = starts.find((entry) => entry.key === input.key);
					// A pre-boot hold may interrupt an invocation before any process starts.
					if (!start) return yield* Effect.never;
					if (used.has(input.key)) fail(`duplicate replay start ${input.key}`);
					used.add(input.key);
					const beforeStart = yield* Clock.currentTimeMillis;
					yield* Effect.sleep(Math.max(0, start.at - beforeStart));
					const at = yield* Clock.currentTimeMillis;
					started.push({ key: input.key, at, resume: input.resume });
					const stem = join(
						copy,
						"runs",
						createHash("sha256").update(input.key).digest("hex"),
					);
					const record = lines(`${stem}.jsonl`).map(object);
					const thread = record.find(
						(entry) => entry.type === "thread.started",
					);
					if (typeof thread?.thread_id === "string")
						emit({ type: "runner.started", sessionId: thread.thread_id });
					const answer = answers.find((entry) => entry.key === input.key);
					if (!answer) {
						const taskId = input.key.slice(0, input.key.lastIndexOf("#"));
						const id = unitForTask(taskId);
						if (id === undefined) fail(`cannot identify unit for ${input.key}`);
						const next = starts
							.slice(starts.indexOf(start) + 1)
							.find(
								(candidate) =>
									unitForTask(
										candidate.key.slice(0, candidate.key.lastIndexOf("#")),
									) === id,
							);
						const events = transitions.filter(
							(row) =>
								row.address === `workspace/unit:${id}/task` &&
								row.at >= start.at &&
								(next === undefined || row.at < next.at) &&
								(row.event.type === "runner.parked" ||
									(row.event.type === "runner.failed" &&
										(row.event.reason === "lost" ||
											row.event.reason === "crashed"))),
						);
						if (events.length === 0 && existsSync(`${stem}.pid.park`))
							return yield* Effect.never;
						if (events.length !== 1)
							fail(`ambiguous or missing failure timing for ${input.key}`);
						const failure = events[0];
						if (!failure) fail(`missing failure for ${input.key}`);
						const beforeFailure = yield* Clock.currentTimeMillis;
						yield* Effect.sleep(Math.max(0, failure.at - beforeFailure));
						if (failure.event.type === "runner.parked")
							emit({ type: "runner.parked" });
						else
							emit({
								type: "runner.failed",
								reason: failure.event.reason === "lost" ? "lost" : "crashed",
								detail:
									typeof failure.event.detail === "string"
										? failure.event.detail
										: "worker error",
							});
						return;
					}
					if (answer.at < start.at) fail(`invalid timing for ${input.key}`);
					const beforeAnswer = yield* Clock.currentTimeMillis;
					yield* Effect.sleep(Math.max(0, answer.at - beforeAnswer));
					answered.push({ key: input.key, at: yield* Clock.currentTimeMillis });
					const failure = record.find((entry) => entry.type === "turn.failed");
					if (failure) {
						const error = object(failure.error);
						if (error.kind === "quota" && typeof error.resetsAt === "number")
							emit({
								type: "runner.limit",
								holdId: `quota:${input.key}`,
								scope: { kind: "account", account: input.worker.account },
								at: yield* Clock.currentTimeMillis,
								resetsAt: error.resetsAt,
							});
						else
							emit({
								type: "runner.failed",
								reason: "crashed",
								detail:
									typeof error.detail === "string"
										? error.detail
										: "worker error",
							});
						return;
					}
					const message = record.findLast(
						(entry) => entry.type === "item.completed",
					);
					const item = object(message?.item);
					if (
						typeof item.text !== "string" ||
						!record.some((entry) => entry.type === "turn.completed")
					)
						fail(`missing answer for ${input.key}`);
					emit({
						type: "runner.report",
						outcome: Schema.decodeUnknownSync(WorkerReport)(
							JSON.parse(item.text),
						),
					});
				}),
		};
		const origin = Math.min(
			...entries.map((row) => row.at),
			...starts.map((row) => row.at),
		);
		if (!Number.isFinite(origin)) throw new Error("recording has no events");
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				yield* TestClock.setTime(origin);
				const actor = yield* createEffectActor(workspace);
				let now = origin;
				for (let i = 0; i < entries.length; i++) {
					const entry = entries[i];
					const event = events[i];
					if (!entry || !event || entry.at < now)
						throw new Error("invalid inbox chronology");
					yield* TestClock.adjust(entry.at - now);
					now = entry.at;
					yield* sendAndAwait(actor, event);
				}
				const end = Math.max(
					now,
					checkpoint.at,
					...answers.map((row) => row.at),
				);
				yield* TestClock.adjust(end - now + 1);
				for (let i = 0; i < 3; i++)
					yield* Effect.promise(
						() => new Promise<void>((resolve) => setImmediate(resolve)),
					);
				return actor.getSnapshot().context.finished;
			}).pipe(
				Effect.scoped,
				Effect.provideService(Workers, workers),
				Effect.provide(TestClock.layer()),
			),
		);
		if (replayError) throw replayError;
		const expected = object(context.finished);
		if (
			Object.keys(result).length !== Object.keys(expected).length ||
			Object.entries(result).some(([key, value]) => expected[key] !== value)
		)
			throw new Error("replay outcomes differ from recording");
		if (
			started.length !== starts.length ||
			started.some((item) => !starts.some((entry) => entry.key === item.key))
		)
			throw new Error("replay starts differ from recording");
		if (
			started.some(
				(item) =>
					Math.abs(
						item.at -
							(starts.find((entry) => entry.key === item.key)?.at ?? Infinity),
					) > 1000,
			) ||
			answered.some(
				(item) =>
					Math.abs(
						item.at -
							(answers.find((entry) => entry.key === item.key)?.at ?? Infinity),
					) > 1000,
			)
		)
			throw new Error("replay timing differs from recording");
		return { finished: result, starts: started, answers: answered };
	} finally {
		const copy = join(temp, "recording");
		if (existsSync(copy)) writableDirectories(copy);
		rmSync(temp, { recursive: true, force: true });
	}
}
