import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { getUnitSettings } from "@makewhether/config";
import { Workers, workspace } from "@makewhether/machines";
import { openStore } from "@makewhether/store";
import { createEffectActor, sendAndAwait } from "@xstate/effect";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { readLock } from "../src/lock.ts";

const exec = promisify(execFile);
const cli = join(import.meta.dirname, "../../cli/src/main.ts");
const host = join(import.meta.dirname, "../src/main.ts");
function setRecordingReadonly(dir: string, readOnly: boolean): void {
	if (!readOnly) chmodSync(dir, 0o700);
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) setRecordingReadonly(path, readOnly);
		else chmodSync(path, readOnly ? 0o400 : 0o600);
	}
	if (readOnly) chmodSync(dir, 0o500);
}
async function wait(check: () => boolean, timeout = 5000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("timed out");
}
function finished(dir: string, id: string) {
	const db = new DatabaseSync(join(dir, "makew.db"), { readOnly: true });
	try {
		const value = String(
			db.prepare("SELECT snapshot FROM checkpoint WHERE id=1").get()
				?.snapshot ?? "{}",
		);
		return JSON.parse(value).context.finished[id] === "passed";
	} finally {
		db.close();
	}
}

test("CLI replays a completed recording from a relocated copy", async () => {
	const root = mkdtempSync(join(tmpdir(), "makew-replay-cli-"));
	const dataDir = join(root, "live");
	const recording = join(root, "copy");
	const env = { ...process.env, MAKEW_DATA_DIR: dataDir, MAKEW_ENGINE: host };
	const command = (...args: string[]) =>
		exec(process.execPath, [cli, ...args], { env });
	try {
		await command("start");
		await command(
			"send",
			JSON.stringify({
				type: "unit.add",
				id: "A",
				brief: "work",
				machine: "unit",
				repo: "repo",
				dependencies: [],
			}),
		);
		await command(
			"send",
			JSON.stringify({
				type: "unit.add",
				id: "B",
				brief: "small",
				machine: "small-unit",
				repo: "repo",
				dependencies: ["A"],
			}),
		);
		await wait(() => finished(dataDir, "A") && finished(dataDir, "B"));
		expect(JSON.parse((await command("unit", "ls")).stdout)).toEqual([]);
		await command("stop");
		cpSync(dataDir, recording, { recursive: true });
		await expect(command("replay", dataDir)).rejects.toThrow();
		const link = join(recording, "runs", "escape");
		symlinkSync(join(dataDir, "makew.db"), link);
		await expect(command("replay", recording)).rejects.toMatchObject({
			stderr: expect.stringContaining("recording contains a symbolic link"),
		});
		unlinkSync(link);
		setRecordingReadonly(recording, true);
		rmSync(dataDir, { recursive: true, force: true });
		const before = await command("replay", recording);
		const result = JSON.parse(before.stdout);
		expect(statSync(recording).mode & 0o777).toBe(0o500);
		expect(statSync(join(recording, "makew.db")).mode & 0o777).toBe(0o400);
		expect(result.finished).toEqual({ A: "passed", B: "passed" });
		expect(result.starts.map((start: { key: string }) => start.key)).toEqual([
			"A/1.implement.fake#1",
			"A/2.verify.fake#1",
			"A/3.judge.fake#1",
			"B/1.implement.fake#1",
			"B/2.verify.fake#1",
		]);
		const rows = readFileSync(join(recording, "runs", "runs.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const expectedStarts = rows
			.filter((row) => row.type === "start")
			.map((row) => ({ key: row.key, at: row.at }));
		const expectedAnswers = rows
			.filter((row) => row.type === "answer")
			.map((row) => ({ key: row.key, at: row.at }));
		expect(result.starts).toEqual(expectedStarts);
		expect(result.answers).toEqual(expectedAnswers);
	} finally {
		if (existsSync(recording)) setRecordingReadonly(recording, false);
		const owner = readLock(join(dataDir, "engine.lock"));
		if (owner) {
			try {
				process.kill(owner.pid, "SIGKILL");
			} catch {}
		}
		rmSync(root, { recursive: true, force: true });
	}
}, 20000);

test("unit HTTP and CLI reads support restored dot IDs and reject bad paths without crashing", async () => {
	const root = mkdtempSync(join(tmpdir(), "makew-unit-cli-"));
	const env = { ...process.env, MAKEW_DATA_DIR: root, MAKEW_ENGINE: host };
	const command = (...args: string[]) =>
		exec(process.execPath, [cli, ...args], { env });
	try {
		const snapshot = await Effect.runPromise(
			Effect.gen(function* () {
				const actor = yield* createEffectActor(workspace);
				yield* sendAndAwait(actor, {
					type: "hold.add",
					hold: { id: "pause", mode: "hard", scope: { kind: "all" } },
				});
				for (const id of [".", ".."])
					yield* sendAndAwait(actor, {
						type: "unit.add",
						id,
						title: id,
						machine: "unit",
						repo: "repo",
						deps: [],
						...getUnitSettings(),
					});
				return JSON.stringify(actor.getPersistedSnapshot());
			}).pipe(
				Effect.scoped,
				Effect.provideService(Workers, {
					run: () => Effect.die("unexpected worker"),
				}),
			),
		);
		const store = openStore(join(root, "makew.db"));
		try {
			store.commit(
				{ machine: workspace.id, version: "1", snapshot, at: Date.now() },
				[],
			);
		} finally {
			store.close();
		}
		await command("start");
		const add = {
			type: "unit.add",
			brief: "waiting",
			machine: "unit",
			repo: "repo",
			dependencies: ["."],
		};
		await expect(
			command("send", JSON.stringify({ ...add, id: "new.id" })),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("task ID components cannot contain"),
		});
		await command("send", JSON.stringify({ ...add, id: "waiting" }));
		let units: { id: string; holds: unknown[]; dependencies: string[] }[] = [];
		for (let i = 0; i < 100; i++) {
			units = JSON.parse((await command("unit", "ls")).stdout);
			if (units.length === 3) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(units).toHaveLength(3);
		expect(JSON.parse((await command("unit", "show", ".")).stdout).id).toBe(
			".",
		);
		expect(JSON.parse((await command("unit", "show", "..")).stdout).id).toBe(
			"..",
		);
		expect(units.find((unit) => unit.id === ".")?.holds).toHaveLength(1);
		expect(units.find((unit) => unit.id === "waiting")?.dependencies).toEqual([
			".",
		]);
		const lock = readLock(join(root, "engine.lock"));
		if (!lock) throw new Error("missing lock");
		expect(
			(await fetch(`http://127.0.0.1:${lock.port}/units/%ZZ`)).status,
		).toBe(404);
		expect((await fetch(`http://127.0.0.1:${lock.port}/health`)).status).toBe(
			200,
		);
		await command("stop");
	} finally {
		const owner = readLock(join(root, "engine.lock"));
		if (owner) {
			try {
				process.kill(owner.pid, "SIGKILL");
			} catch {}
		}
		rmSync(root, { recursive: true, force: true });
	}
}, 20000);

test("machine check validates waits, handlers, moving up and the final intervention tier", async () => {
	const root = mkdtempSync(join(tmpdir(), "makew-check-"));
	const env = { ...process.env, MAKEW_DATA_DIR: root, MAKEW_ENGINE: host };
	const command = (...args: string[]) =>
		exec(process.execPath, [cli, ...args], { env });
	try {
		const builtIn = await command(
			"machine",
			"check",
			join(import.meta.dirname, "../../machines/src/unit.ts"),
		);
		expect(builtIn.stdout).toContain("machine check passed");
		const smaller = await command(
			"machine",
			"check",
			join(import.meta.dirname, "../../machines/src/small-unit.ts"),
		);
		expect(smaller.stdout).toContain("machine check passed");
		const broken = join(root, "broken.ts");
		writeFileSync(
			broken,
			'export default {config:{states:{outer:{states:{bad:{meta:{waitsOn:"task",role:"review",phase:"review",handles:["pass"]},invoke:{onDone:()=>{}}},missing:{},incomplete:{meta:{waitsOn:"task",role:"other",phase:"other",handles:["up"]},invoke:{onDone:undefined}}}}}}};',
		);
		await expect(command("machine", "check", broken)).rejects.toMatchObject({
			stderr: expect.stringMatching(
				/outer.bad.*move up[\s\S]*outer.missing.*waitsOn[\s\S]*outer.incomplete.*completion route[\s\S]*no intervene/,
			),
		});
		const original = getUnitSettings();
		const agent = original.routes.implement[0];
		const person = original.routes.intervene[0];
		const machine = join(import.meta.dirname, "../../machines/src/unit.ts");
		const checkWithSettings = (name: string, final: typeof person) => {
			const settings = join(root, `${name}.ts`);
			writeFileSync(
				settings,
				`export default ${JSON.stringify({
					...original,
					routes: { ...original.routes, intervene: [agent, final] },
				})};`,
			);
			return exec(process.execPath, [cli, "machine", "check", machine], {
				env: { ...env, MAKEW_CONFIG: settings },
			});
		};
		await expect(checkWithSettings("agent-only", agent)).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining(
				"error: final intervention tier must contain only person workers",
			),
		});
		await expect(
			checkWithSettings("mixed", {
				...person,
				workers: [...agent.workers, ...person.workers],
			}),
		).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining(
				"error: final intervention tier must contain only person workers",
			),
		});
		const valid = await checkWithSettings("person-only", person);
		expect(valid.stdout).toContain("machine check passed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("replay accepts an offline recording that has no worker runs", async () => {
	const root = mkdtempSync(join(tmpdir(), "makew-empty-replay-"));
	const dataDir = join(root, "live");
	const recording = join(root, "copy");
	const env = { ...process.env, MAKEW_DATA_DIR: dataDir, MAKEW_ENGINE: host };
	const command = (...args: string[]) =>
		exec(process.execPath, [cli, ...args], { env });
	try {
		await command("start");
		await command(
			"send",
			JSON.stringify({
				type: "hold.add",
				kind: "pause",
				mode: "hard",
				scope: { kind: "all" },
			}),
		);
		await command(
			"send",
			JSON.stringify({
				type: "unit.add",
				id: "A",
				brief: "work",
				machine: "unit",
				repo: "repo",
				dependencies: [],
			}),
		);
		for (let i = 0; i < 100; i++) {
			const rows = JSON.parse((await command("unit", "ls")).stdout);
			if (rows.length === 1) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		await command("stop");
		cpSync(dataDir, recording, { recursive: true });
		expect(
			JSON.parse((await command("replay", recording)).stdout),
		).toMatchObject({ finished: {}, starts: [] });
	} finally {
		const owner = readLock(join(dataDir, "engine.lock"));
		if (owner) {
			try {
				process.kill(owner.pid, "SIGKILL");
			} catch {}
		}
		rmSync(root, { recursive: true, force: true });
	}
}, 20000);

test("replay rejects a run cancelled before its recorded start", async () => {
	const root = mkdtempSync(join(tmpdir(), "makew-unstarted-replay-"));
	const runs = join(root, "runs");
	mkdirSync(runs);
	const key = "A/1.implement.fake#1";
	writeFileSync(
		join(runs, "runs.jsonl"),
		`${JSON.stringify({ type: "start", key, at: 30 })}\n${JSON.stringify({ type: "answer", key, at: 40 })}\n`,
	);
	const db = new DatabaseSync(join(root, "makew.db"));
	try {
		db.exec(
			"CREATE TABLE checkpoint (id INTEGER, machine TEXT, version TEXT, snapshot TEXT, at INTEGER); CREATE TABLE audit (seq INTEGER, kind TEXT, at INTEGER, address TEXT, event TEXT)",
		);
		db.prepare("INSERT INTO checkpoint VALUES (1,?,?,?,?)").run(
			"workspace",
			"1",
			JSON.stringify({
				context: { units: [{ id: "A", deps: [] }], finished: {} },
			}),
			25,
		);
		const add = {
			type: "unit.add",
			id: "A",
			title: "A",
			repo: "repo",
			deps: [],
			...getUnitSettings(),
		};
		const hold = {
			type: "hold.add",
			hold: { id: "pause", mode: "hard", scope: { kind: "all" } },
		};
		const insert = db.prepare("INSERT INTO audit VALUES (?,?,?,?,?)");
		insert.run(1, "inbox", 10, "workspace", JSON.stringify(add));
		insert.run(2, "inbox", 20, "workspace", JSON.stringify(hold));
	} finally {
		db.close();
	}
	const env = {
		...process.env,
		MAKEW_DATA_DIR: join(root, "other"),
		MAKEW_ENGINE: host,
	};
	try {
		await expect(
			exec(process.execPath, [cli, "replay", root], { env }),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("replay starts differ from recording"),
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("replay handles a boot hold that interrupts an invocation before it starts", async () => {
	const root = mkdtempSync(join(tmpdir(), "makew-preboot-replay-"));
	const dataDir = join(root, "live");
	const recording = join(root, "copy");
	const inbox = join(dataDir, "inbox");
	mkdirSync(inbox, { recursive: true });
	writeFileSync(
		join(inbox, "a-unit.json"),
		JSON.stringify({
			type: "unit.add",
			id: "A",
			brief: "work",
			machine: "unit",
			repo: "repo",
			dependencies: [],
		}),
	);
	writeFileSync(
		join(inbox, "b-pause.json"),
		JSON.stringify({
			type: "hold.add",
			kind: "pause",
			mode: "hard",
			scope: { kind: "all" },
		}),
	);
	const env = { ...process.env, MAKEW_DATA_DIR: dataDir, MAKEW_ENGINE: host };
	const command = (...args: string[]) =>
		exec(process.execPath, [cli, ...args], { env });
	try {
		await command("start");
		expect(existsSync(join(dataDir, "runs", "runs.jsonl"))).toBe(false);
		await command(
			"send",
			JSON.stringify({ type: "hold.lift", holdId: "b-pause" }),
		);
		await wait(() => finished(dataDir, "A"));
		await command("stop");
		cpSync(dataDir, recording, { recursive: true });
		const result = JSON.parse((await command("replay", recording)).stdout);
		expect(result.finished).toEqual({ A: "passed" });
		expect(result.starts[0].key).toBe("A/1.implement.fake#2");
	} finally {
		const owner = readLock(join(dataDir, "engine.lock"));
		if (owner) {
			try {
				process.kill(owner.pid, "SIGKILL");
			} catch {}
		}
		rmSync(root, { recursive: true, force: true });
	}
}, 20000);

test("legacy loss matching stops at the next task for the same unit", async () => {
	const root = mkdtempSync(join(tmpdir(), "makew-loss-interval-"));
	const runs = join(root, "runs");
	mkdirSync(runs);
	const first = "A/1.implement.fake#1";
	const second = "A/2.intervene.agent#1";
	for (const [key, at] of [
		[first, 10],
		[second, 30],
	] as const) {
		appendFileSync(
			join(runs, "runs.jsonl"),
			`${JSON.stringify({ type: "start", key, at })}\n`,
		);
		writeFileSync(
			join(runs, `${createHash("sha256").update(key).digest("hex")}.jsonl`),
			`${JSON.stringify({ type: "thread.started", thread_id: key })}\n`,
		);
	}
	const settings = getUnitSettings();
	const human = settings.routes.intervene[0];
	const agent = { ...settings.routes.implement[0], tier: "agent" };
	const add = {
		type: "unit.add",
		id: "A",
		title: "A",
		repo: "repo",
		deps: [],
		...settings,
		attemptLimit: 1,
		routes: { ...settings.routes, intervene: [agent, human] },
	};
	const db = new DatabaseSync(join(root, "makew.db"));
	try {
		db.exec(
			"CREATE TABLE checkpoint (id INTEGER, machine TEXT, version TEXT, snapshot TEXT, at INTEGER); CREATE TABLE audit (seq INTEGER, kind TEXT, at INTEGER, address TEXT, event TEXT)",
		);
		db.prepare("INSERT INTO checkpoint VALUES (1,?,?,?,?)").run(
			"workspace",
			"1",
			JSON.stringify({
				context: { units: [{ id: "A", deps: [] }], finished: {} },
			}),
			45,
		);
		const insert = db.prepare("INSERT INTO audit VALUES (?,?,?,?,?)");
		insert.run(1, "inbox", 0, "workspace", JSON.stringify(add));
		insert.run(
			2,
			"transition",
			20,
			"workspace/unit:A/task",
			JSON.stringify({
				type: "runner.failed",
				reason: "lost",
				detail: "first",
			}),
		);
		insert.run(
			3,
			"transition",
			40,
			"workspace/unit:A/task",
			JSON.stringify({
				type: "runner.failed",
				reason: "lost",
				detail: "second",
			}),
		);
	} finally {
		db.close();
	}
	const env = {
		...process.env,
		MAKEW_DATA_DIR: join(root, "other"),
		MAKEW_ENGINE: host,
	};
	try {
		const result = JSON.parse(
			(await exec(process.execPath, [cli, "replay", root], { env })).stdout,
		);
		expect(result.starts.map((row: { key: string }) => row.key)).toEqual([
			first,
			second,
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
