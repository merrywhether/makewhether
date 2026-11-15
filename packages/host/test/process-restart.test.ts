import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { getUnitSettings } from "@makewhether/config";
import { getProcessState } from "@makewhether/runner";
import { expect, test } from "vitest";
import { readLock } from "../src/lock.ts";

const exec = promisify(execFile);
const cli = join(import.meta.dirname, "../../cli/src/main.ts");
const engine = join(import.meta.dirname, "../src/main.ts");
async function waitFor(check: () => boolean, timeout = 7000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("timed out waiting for engine state");
}
function auditEntries(dir: string): { at: number; event: string }[] {
	const db = new DatabaseSync(join(dir, "makew.db"), { readOnly: true });
	try {
		return db
			.prepare("SELECT at, event FROM audit ORDER BY seq")
			.all()
			.map((row) => ({ at: Number(row.at), event: String(row.event) }));
	} finally {
		db.close();
	}
}
function audit(dir: string, type: string): boolean {
	return auditEntries(dir).some((row) =>
		row.event.includes(`"type":"${type}"`),
	);
}
function asking(dir: string): boolean {
	const db = new DatabaseSync(join(dir, "makew.db"), { readOnly: true });
	try {
		const snapshot = String(
			db.prepare("SELECT snapshot FROM checkpoint WHERE id = 1").get()
				?.snapshot ?? "",
		);
		return (
			snapshot.includes("U/3.judge.person") &&
			snapshot.includes('"value":"asking"')
		);
	} finally {
		db.close();
	}
}
function cleanup(dataDir: string): void {
	const engine = readLock(join(dataDir, "engine.lock"));
	if (engine && getProcessState(engine) === "alive") {
		try {
			process.kill(engine.pid, "SIGKILL");
		} catch {}
	}
	const runs = join(dataDir, "runs");
	if (existsSync(runs)) {
		for (const name of readdirSync(runs).filter((item) =>
			item.endsWith(".pid"),
		)) {
			const owner = JSON.parse(readFileSync(join(runs, name), "utf8"));
			if (getProcessState(owner) === "alive") {
				try {
					process.kill(-owner.pid, "SIGKILL");
				} catch {}
			}
		}
		const log = join(runs, "runs.jsonl");
		if (existsSync(log))
			for (const line of readFileSync(log, "utf8").trim().split("\n")) {
				const row = JSON.parse(line);
				if (
					row.type === "start" &&
					typeof row.startedAt === "string" &&
					getProcessState(row) === "alive"
				) {
					try {
						process.kill(row.pid, "SIGKILL");
					} catch {}
				}
			}
	}
	rmSync(dataDir, { recursive: true, force: true });
}
const add = {
	type: "unit.add",
	id: "U",
	brief: "test",
	machine: "unit",
	repo: "repo",
	dependencies: [],
};

test("two engine crashes preserve a quota timer and a down-time person answer", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "makew-two-crashes-"));
	const defaults = getUnitSettings();
	const settings = {
		...defaults,
		routes: { ...defaults.routes, judge: defaults.routes.intervene },
	};
	const config = join(dataDir, "settings.ts");
	writeFileSync(config, `export default ${JSON.stringify(settings)};`);
	const env = {
		...process.env,
		MAKEW_DATA_DIR: dataDir,
		MAKEW_ENGINE: engine,
		MAKEW_CONFIG: config,
		MAKEW_FAKE_PLAN: JSON.stringify({
			"U/1.implement.fake#1": { outcome: "quota", resetMs: 4000 },
		}),
	};
	const command = (...args: string[]) =>
		exec(process.execPath, [cli, ...args], { env });
	const killEngine = () => {
		const owner = readLock(join(dataDir, "engine.lock"));
		if (!owner) throw new Error("missing lock");
		process.kill(owner.pid, "SIGKILL");
	};
	try {
		await command("start");
		await command("send", JSON.stringify(add));
		await waitFor(
			() =>
				existsSync(join(dataDir, "evidence.jsonl")) &&
				audit(dataDir, "runner.limit"),
		);
		const evidence = JSON.parse(
			readFileSync(join(dataDir, "evidence.jsonl"), "utf8").trim(),
		);
		const deadline = JSON.parse(evidence.raw).error.resetsAt;
		killEngine();
		const restartedAt = Date.now();
		await command("start");
		await waitFor(() => audit(dataDir, "hold.lifted"), 6500);
		const lift = auditEntries(dataDir).find((row) =>
			row.event.includes('"type":"hold.lifted"'),
		);
		expect(lift).toBeDefined();
		expect(lift?.at).toBeGreaterThanOrEqual(restartedAt);
		expect(Math.abs((lift?.at ?? 0) - deadline)).toBeLessThan(1000);
		await waitFor(() => asking(dataDir));
		killEngine();
		await command(
			"send",
			JSON.stringify({
				type: "task.answer",
				taskId: "U/3.judge.person",
				outcome: { kind: "done", verdict: "pass", detail: "human" },
			}),
		);
		await command("start");
		await waitFor(() => audit(dataDir, "unit.finished"));
		await command("stop");
		const runs = join(dataDir, "runs");
		const starts = readFileSync(join(runs, "runs.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((line) => line.type === "start");
		expect(new Set(starts.map((line) => line.key)).size).toBe(starts.length);
		const owners = readdirSync(runs)
			.filter((name) => name.endsWith(".pid"))
			.map((name) => JSON.parse(readFileSync(join(runs, name), "utf8")));
		await waitFor(() =>
			[...owners, ...starts].every(
				(owner) =>
					typeof owner.startedAt === "string" &&
					getProcessState(owner) === "dead",
			),
		);
	} finally {
		cleanup(dataDir);
	}
}, 20000);

test("a worker killed while engine is down retries once with its recorded session", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "makew-lost-restart-"));
	const key = "U/1.implement.fake#1";
	const env = {
		...process.env,
		MAKEW_DATA_DIR: dataDir,
		MAKEW_ENGINE: engine,
		MAKEW_FAKE_PLAN: JSON.stringify({ [key]: { delayMs: 10000 } }),
	};
	const command = (...args: string[]) =>
		exec(process.execPath, [cli, ...args], { env });
	try {
		await command("start");
		await command("send", JSON.stringify(add));
		const stem = join(
			dataDir,
			"runs",
			createHash("sha256").update(key).digest("hex"),
		);
		await waitFor(
			() =>
				existsSync(`${stem}.jsonl`) &&
				readFileSync(`${stem}.jsonl`, "utf8").includes("thread.started") &&
				audit(dataDir, "runner.started"),
		);
		const owner = readLock(join(dataDir, "engine.lock"));
		if (!owner) throw new Error("missing lock");
		process.kill(owner.pid, "SIGKILL");
		const wrapper = JSON.parse(readFileSync(`${stem}.pid`, "utf8"));
		const firstStart = JSON.parse(
			readFileSync(join(dataDir, "runs", "runs.jsonl"), "utf8").split(
				"\n",
			)[0] ?? "{}",
		);
		expect(firstStart.pid).toBe(wrapper.pid);
		process.kill(wrapper.pid, "SIGKILL");
		await command("start");
		await waitFor(() => audit(dataDir, "unit.finished"));
		await command("stop");
		const starts = readFileSync(join(dataDir, "runs", "runs.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((line) => line.type === "start");
		const first = starts.find((row) => row.key === key);
		const retry = starts.find((row) => row.key === "U/1.implement.fake#2");
		const thread = JSON.parse(
			readFileSync(`${stem}.jsonl`, "utf8").split("\n")[0] ?? "{}",
		).thread_id;
		expect(first).toBeDefined();
		expect(retry).toMatchObject({ mode: "resume", resume: thread });
		expect(
			starts.filter(
				(row) => row.key === key || row.key === "U/1.implement.fake#2",
			),
		).toHaveLength(2);
		await waitFor(() =>
			starts.every(
				(row) =>
					typeof row.startedAt === "string" && getProcessState(row) === "dead",
			),
		);
	} finally {
		cleanup(dataDir);
	}
}, 20000);

test("clean stop leaves an active worker alive and the next engine reattaches", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "makew-clean-stop-"));
	const key = "U/1.implement.fake#1";
	const env = {
		...process.env,
		MAKEW_DATA_DIR: dataDir,
		MAKEW_ENGINE: engine,
		MAKEW_FAKE_PLAN: JSON.stringify({ [key]: { delayMs: 10000 } }),
	};
	const command = (...args: string[]) =>
		exec(process.execPath, [cli, ...args], { env });
	const runs = join(dataDir, "runs");
	const stem = join(runs, createHash("sha256").update(key).digest("hex"));
	try {
		await command("start");
		await command("send", JSON.stringify(add));
		await waitFor(
			() =>
				existsSync(`${stem}.jsonl`) &&
				readFileSync(`${stem}.jsonl`, "utf8").includes("thread.started") &&
				audit(dataDir, "runner.started"),
		);
		const worker = JSON.parse(readFileSync(`${stem}.pid`, "utf8"));
		expect(getProcessState(worker)).toBe("alive");
		await command("stop");
		expect(getProcessState(worker)).toBe("alive");
		expect(existsSync(`${stem}.pid.park`)).toBe(false);
		await command("start");
		await waitFor(() =>
			readFileSync(join(runs, "runs.jsonl"), "utf8").includes(
				'"type":"reattach"',
			),
		);
		expect(JSON.parse(readFileSync(`${stem}.pid`, "utf8"))).toEqual(worker);
		const starts = readFileSync(join(runs, "runs.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((row) => row.type === "start" && row.key === key);
		expect(starts).toHaveLength(1);
		await command("stop");
	} finally {
		cleanup(dataDir);
	}
}, 20000);
