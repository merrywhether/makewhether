import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerEvent, RunnerInput } from "@makewhether/domain";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { createProcessWorkers, getProcessStart } from "../src/index.ts";

const worker = {
	harness: "codex",
	model: "model",
	account: "account",
} as const;
const input: RunnerInput = {
	key: "U/1.implement.main#1",
	run: 1,
	worker,
	resume: undefined,
	spec: {
		taskId: "U/1.implement.main",
		phase: "implement",
		repo: "repo",
		title: "test",
		tier: "main",
		workers: [worker],
		notes: [],
		prior: undefined,
		attemptLimit: 2,
	},
};
const collect = (workers: ReturnType<typeof createProcessWorkers>) =>
	Effect.runPromise(Effect.scoped(workers.run(input, () => {})));

test("two competing wrappers retain one durable claim and one harness start", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "makew-claim-"));
	const runs = join(dataDir, "runs");
	const workers = createProcessWorkers({ dataDir });
	try {
		const wrapper = join(import.meta.dirname, "../src/wrapper.ts");
		const run = () =>
			new Promise<void>((resolve, reject) => {
				const child = spawn(process.execPath, [
					wrapper,
					runs,
					input.key,
					JSON.stringify(input),
				]);
				child.on("error", reject);
				child.on("exit", (code) =>
					code === 0 ? resolve() : reject(new Error(`wrapper exited ${code}`)),
				);
			});
		await Promise.all([run(), run()]);
		await run(); // a delayed old wrapper must lose even after completion
		const log = readFileSync(join(runs, "runs.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(log.filter((row) => row.type === "start")).toHaveLength(1);
		await collect(workers); // replay is allowed with the gate closed
	} finally {
		workers.shutdown();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("dead identity recovers session before reporting lost; mismatched live PID is never signalled", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "makew-lost-"));
	const workers = createProcessWorkers({ dataDir });
	const stem = join(
		dataDir,
		"runs",
		createHash("sha256").update(input.key).digest("hex"),
	);
	try {
		expect(getProcessStart(process.pid)).toBeDefined();
		writeFileSync(
			`${stem}.pid`,
			JSON.stringify({ pid: process.pid, startedAt: "not its start" }),
		);
		writeFileSync(
			`${stem}.jsonl`,
			`${JSON.stringify({ type: "thread.started", thread_id: "recovered" })}\n`,
		);
		const events: RunnerEvent[] = [];
		await Effect.runPromise(
			Effect.scoped(workers.run(input, (event) => events.push(event))),
		);
		expect(events).toEqual([
			{ type: "runner.started", sessionId: "recovered" },
			{
				type: "runner.failed",
				reason: "lost",
				detail: "Worker process stopped",
			},
		]);
	} finally {
		workers.shutdown();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("a deliberately parked dead run waits for the boot gate and preserves its session", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "makew-parked-"));
	const workers = createProcessWorkers({ dataDir });
	const stem = join(
		dataDir,
		"runs",
		createHash("sha256").update(input.key).digest("hex"),
	);
	try {
		writeFileSync(
			`${stem}.pid`,
			JSON.stringify({ pid: process.pid, startedAt: "different" }),
		);
		writeFileSync(`${stem}.pid.park`, "parked");
		writeFileSync(
			`${stem}.jsonl`,
			`${JSON.stringify({ type: "thread.started", thread_id: "session" })}\n`,
		);
		const events: RunnerEvent[] = [];
		const result = Effect.runPromise(
			Effect.scoped(workers.run(input, (event) => events.push(event))),
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(events).toEqual([{ type: "runner.started", sessionId: "session" }]);
		workers.openGate();
		await result;
		expect(events).toEqual([
			{ type: "runner.started", sessionId: "session" },
			{ type: "runner.parked" },
		]);
	} finally {
		workers.shutdown();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test.each(["quota", "error"])(
	"%s replay records the raw evidence and path",
	async (kind) => {
		const dataDir = mkdtempSync(join(tmpdir(), "makew-evidence-"));
		const workers = createProcessWorkers({ dataDir });
		const runs = join(dataDir, "runs");
		try {
			const wrapper = join(import.meta.dirname, "../src/wrapper.ts");
			await new Promise<void>((resolve, reject) => {
				const child = spawn(
					process.execPath,
					[wrapper, runs, input.key, JSON.stringify(input)],
					{
						env: {
							...process.env,
							MAKEW_FAKE_PLAN: JSON.stringify({
								[input.key]: { outcome: kind, resetMs: 5000 },
							}),
						},
					},
				);
				child.on("error", reject);
				child.on("exit", (code) =>
					code === 0 ? resolve() : reject(new Error(`wrapper exited ${code}`)),
				);
			});
			const events: RunnerEvent[] = [];
			await Effect.runPromise(
				Effect.scoped(workers.run(input, (event) => events.push(event))),
			);
			expect(events.at(-1)?.type).toBe(
				kind === "quota" ? "runner.limit" : "runner.failed",
			);
			const evidence = JSON.parse(
				readFileSync(join(dataDir, "evidence.jsonl"), "utf8").trim(),
			);
			expect(evidence).toMatchObject({
				key: input.key,
				path: join(
					runs,
					`${createHash("sha256").update(input.key).digest("hex")}.jsonl`,
				),
			});
			expect(JSON.parse(evidence.raw)).toMatchObject({
				type: "turn.failed",
				error: { kind, message: expect.any(String) },
			});
			await Effect.runPromise(Effect.scoped(workers.run(input, () => {})));
			expect(
				readFileSync(join(dataDir, "evidence.jsonl"), "utf8")
					.trim()
					.split("\n"),
			).toHaveLength(1);
		} finally {
			workers.shutdown();
			rmSync(dataDir, { recursive: true, force: true });
		}
	},
);

test("live record reattaches even while the start gate is closed", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "makew-reattach-"));
	const workers = createProcessWorkers({ dataDir });
	const runs = join(dataDir, "runs");
	const wrapper = join(import.meta.dirname, "../src/wrapper.ts");
	const child = spawn(
		process.execPath,
		[wrapper, runs, input.key, JSON.stringify(input)],
		{
			env: {
				...process.env,
				MAKEW_FAKE_PLAN: JSON.stringify({ [input.key]: { delayMs: 700 } }),
			},
		},
	);
	try {
		const stem = join(
			runs,
			createHash("sha256").update(input.key).digest("hex"),
		);
		for (
			let i = 0;
			i < 200 &&
			!readFileSyncIfExists(`${stem}.jsonl`).includes("thread.started");
			i++
		)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(readFileSyncIfExists(`${stem}.jsonl`)).toContain("thread.started");
		const events: RunnerEvent[] = [];
		await Effect.runPromise(
			Effect.scoped(workers.run(input, (event) => events.push(event))),
		);
		expect(events.map((event) => event.type)).toEqual([
			"runner.started",
			"runner.report",
		]);
		expect(readFileSync(join(runs, "runs.jsonl"), "utf8")).toContain(
			'"type":"reattach"',
		);
	} finally {
		workers.shutdown();
		child.kill("SIGKILL");
		rmSync(dataDir, { recursive: true, force: true });
	}
});
function readFileSyncIfExists(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

test("a fresh process cannot claim or start until the boot gate opens", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "makew-new-gate-"));
	const workers = createProcessWorkers({ dataDir });
	const runs = join(dataDir, "runs");
	const pending = collect(workers);
	try {
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(readdirSync(runs)).toEqual([]);
		workers.openGate();
		await pending;
		expect(readFileSync(join(runs, "runs.jsonl"), "utf8")).toContain(
			'"type":"start"',
		);
	} finally {
		workers.openGate();
		workers.shutdown();
		await pending;
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("the fake harness remains independently executable and writes JSONL to stdout", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "makew-standalone-"));
	try {
		const output = await new Promise<string>((resolve, reject) => {
			const child = spawn(process.execPath, [
				join(import.meta.dirname, "../src/fake-harness.ts"),
				JSON.stringify(input),
				dataDir,
			]);
			let stdout = "";
			child.stdout.on("data", (chunk) => {
				stdout += String(chunk);
			});
			child.on("error", reject);
			child.on("exit", (code) =>
				code === 0
					? resolve(stdout)
					: reject(new Error(`fake harness exited ${code}`)),
			);
		});
		const records = output
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records[0]).toMatchObject({ type: "thread.started" });
		expect(records.at(-1)).toEqual({ type: "turn.completed" });
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("a wrapper finding a preexisting park marker exits before creating a run", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "makew-park-before-claim-"));
	const workers = createProcessWorkers({ dataDir });
	const runs = join(dataDir, "runs");
	const stem = join(runs, createHash("sha256").update(input.key).digest("hex"));
	try {
		writeFileSync(`${stem}.pid.park`, "parked");
		const child = spawn(process.execPath, [
			join(import.meta.dirname, "../src/wrapper.ts"),
			runs,
			input.key,
			JSON.stringify(input),
		]);
		const code = await new Promise<number | undefined>((resolve, reject) => {
			child.on("error", reject);
			child.on("exit", (value) => resolve(value ?? undefined));
		});
		expect(code).toBe(0);
		expect(readdirSync(runs).sort()).toEqual([
			`${createHash("sha256").update(input.key).digest("hex")}.pid`,
			`${createHash("sha256").update(input.key).digest("hex")}.pid.park`,
		]);
	} finally {
		workers.shutdown();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("quota replay and its timeline entry use the Effect clock", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "makew-clock-"));
	const workers = createProcessWorkers({ dataDir });
	const stem = join(
		dataDir,
		"runs",
		createHash("sha256").update(input.key).digest("hex"),
	);
	try {
		writeFileSync(
			`${stem}.jsonl`,
			`${JSON.stringify({ type: "turn.failed", error: { kind: "quota", resetsAt: 100000 } })}\n`,
		);
		const events: RunnerEvent[] = [];
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* TestClock.setTime(12345);
				yield* workers.run(input, (event) => events.push(event));
			}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
		);
		expect(events).toMatchObject([
			{ type: "runner.limit", at: 12345, resetsAt: 100000 },
		]);
		expect(
			JSON.parse(
				readFileSync(join(dataDir, "runs", "runs.jsonl"), "utf8").trim(),
			),
		).toMatchObject({ type: "replay", at: 12345 });
	} finally {
		workers.shutdown();
		rmSync(dataDir, { recursive: true, force: true });
	}
});
