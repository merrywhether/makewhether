import { execFile, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getUnitSettings } from "@makewhether/config";
import { getProcessState } from "@makewhether/runner";
import { openStore } from "@makewhether/store";
import { expect, test } from "vitest";
import { readLock } from "../src/lock.ts";
import { recordedWorkers, removeEngineData } from "./engine-data.ts";

const run = promisify(execFile);
const cli = join(import.meta.dirname, "../../cli/src/main.ts");

test.each(["configured executable", "PATH shell shim"])(
	"CLI starts via %s, writes an inbox command and stops it",
	async (mode) => {
		const dataDir = mkdtempSync(join(tmpdir(), "makew-cli-"));
		const engine = join(import.meta.dirname, "../src/main.ts");
		if (mode === "PATH shell shim")
			writeFileSync(
				join(dataDir, "makew-engine"),
				'#!/bin/sh\nexec "$FAKE_NODE" "$FAKE_HOST" "$@"\n',
				{ mode: 0o755 },
			);
		const env = {
			...process.env,
			MAKEW_DATA_DIR: dataDir,
			MAKEW_ENGINE: mode === "configured executable" ? engine : undefined,
			PATH: `${dataDir}:${process.env.PATH ?? ""}`,
			FAKE_NODE: process.execPath,
			FAKE_HOST: engine,
		};
		try {
			await run(process.execPath, [cli, "start"], { env });
			const lock = readLock(join(dataDir, "engine.lock"));
			expect(lock).toBeDefined();
			if (!lock) throw new Error("missing engine lock");
			const response = await fetch(`http://127.0.0.1:${lock.port}/health`);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ dataDir, pid: lock.pid });
			await expect(
				run(process.execPath, [cli, "send", JSON.stringify({ type: "typo" })], {
					env,
				}),
			).rejects.toThrow();
			expect(
				readdirSync(join(dataDir, "inbox")).filter((name) =>
					name.endsWith(".json"),
				),
			).toEqual([]);
			const { stdout } = await run(
				process.execPath,
				[
					cli,
					"send",
					JSON.stringify({
						type: "hold.add",
						kind: "pause",
						mode: "hard",
						scope: { kind: "all" },
					}),
				],
				{ env },
			);
			expect(stdout.trim()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
			await run(process.execPath, [cli, "stop"], { env });
			expect(readLock(join(dataDir, "engine.lock"))).toBeUndefined();
			const fixedPortEnv = { ...env, MAKEW_PORT: String(lock.port) };
			await run(process.execPath, [cli, "start"], { env: fixedPortEnv });
			expect(readLock(join(dataDir, "engine.lock"))?.port).toBe(lock.port);
			await run(process.execPath, [cli, "stop"], { env: fixedPortEnv });
			expect(readLock(join(dataDir, "engine.lock"))).toBeUndefined();
			expect(readFileSync(join(dataDir, "engine.log"), "utf8")).not.toContain(
				"Error",
			);
		} finally {
			await removeEngineData(dataDir);
		}
	},
);

test("engine loads configured limits into recorded unit events and rejects invalid config", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "makew-config-cli-"));
	const file = join(dataDir, "settings.ts");
	const defaults = getUnitSettings();
	const settings = {
		...defaults,
		maxRounds: 7,
		attemptLimit: 4,
		routes: { ...defaults.routes, implement: defaults.routes.intervene },
	};
	writeFileSync(file, `export default ${JSON.stringify(settings)};`);
	const env = {
		...process.env,
		MAKEW_DATA_DIR: dataDir,
		MAKEW_ENGINE: join(import.meta.dirname, "../src/main.ts"),
		MAKEW_CONFIG: file,
	};
	try {
		await run(process.execPath, [cli, "start"], { env });
		const { stdout } = await run(
			process.execPath,
			[
				cli,
				"send",
				JSON.stringify({
					type: "unit.add",
					brief: "test",
					machine: "unit",
					repo: "repo",
					dependencies: [],
				}),
			],
			{ env },
		);
		const id = stdout.trim();
		for (
			let i = 0;
			i < 200 && existsSync(join(dataDir, "inbox", `${id}.json`));
			i++
		)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(existsSync(join(dataDir, "inbox", `${id}.json`))).toBe(false);
		await run(process.execPath, [cli, "stop"], { env });
		for (let i = 0; i < 200 && readLock(join(dataDir, "engine.lock")); i++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(readLock(join(dataDir, "engine.lock"))).toBeUndefined();
		const store = openStore(join(dataDir, "makew.db"));
		try {
			const entry = store
				.getAudit()
				.find((item) => item.kind === "inbox" && item.key === id);
			expect(entry).toBeDefined();
			expect(JSON.parse(entry?.event ?? "{}")).toMatchObject({
				id,
				maxRounds: 7,
				attemptLimit: 4,
			});
		} finally {
			store.close();
		}
		const invalid = join(dataDir, "invalid.ts");
		writeFileSync(
			invalid,
			`export default ${JSON.stringify({ ...settings, attemptLimit: 0 })};`,
		);
		await expect(
			run(process.execPath, [cli, "start"], {
				env: { ...env, MAKEW_CONFIG: invalid },
			}),
		).rejects.toThrow();
		expect(readLock(join(dataDir, "engine.lock"))).toBeUndefined();
	} finally {
		await removeEngineData(dataDir);
	}
});

test("a second engine fails while the first runs and starts after SIGKILL", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "makew-singleton-"));
	const host = join(import.meta.dirname, "../src/main.ts");
	const first = spawn(process.execPath, [host, "serve", dataDir], {
		stdio: "ignore",
	});
	let replacement: ReturnType<typeof spawn> | undefined;
	try {
		let owner = readLock(join(dataDir, "engine.lock"));
		for (let i = 0; i < 200 && !owner; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			owner = readLock(join(dataDir, "engine.lock"));
		}
		expect(owner?.pid).toBe(first.pid);
		await expect(
			run(process.execPath, [host, "serve", dataDir], { timeout: 5000 }),
		).rejects.toThrow();
		const exited = new Promise<void>((resolve) =>
			first.once("exit", () => resolve()),
		);
		first.kill("SIGKILL");
		await exited;
		replacement = spawn(process.execPath, [host, "serve", dataDir], {
			stdio: "ignore",
		});
		for (
			let i = 0;
			i < 200 &&
			readLock(join(dataDir, "engine.lock"))?.pid !== replacement.pid;
			i++
		)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(readLock(join(dataDir, "engine.lock"))?.pid).toBe(replacement.pid);
		const stopped = new Promise<number | undefined>((resolve) =>
			replacement?.once("exit", (code) => resolve(code ?? undefined)),
		);
		replacement.kill("SIGTERM");
		expect(await stopped).toBe(0);
		expect(readLock(join(dataDir, "engine.lock"))).toBeUndefined();
	} finally {
		first.kill("SIGKILL");
		replacement?.kill("SIGKILL");
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("executable drains a pending pause before opening its worker gate", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "makew-boot-order-"));
	const inbox = join(dataDir, "inbox");
	mkdirSync(inbox);
	writeFileSync(
		join(inbox, "a-unit.json"),
		JSON.stringify({
			type: "unit.add",
			id: "U",
			brief: "test",
			machine: "unit",
			repo: "repo",
			dependencies: [],
		}),
	);
	writeFileSync(
		join(inbox, "z-pause.json"),
		JSON.stringify({
			type: "hold.add",
			kind: "pause",
			mode: "hard",
			scope: { kind: "all" },
		}),
	);
	const env = {
		...process.env,
		MAKEW_DATA_DIR: dataDir,
		MAKEW_ENGINE: join(import.meta.dirname, "../src/main.ts"),
		MAKEW_FAKE_PLAN: JSON.stringify({
			"U/1.implement.fake#1": { delayMs: 10_000 },
			"U/1.implement.fake#2": { delayMs: 10_000 },
		}),
	};
	let worker: ReturnType<typeof recordedWorkers>[number] | undefined;
	try {
		await run(process.execPath, [cli, "start"], { env });
		await run(process.execPath, [cli, "stop"], { env });
		const before = openStore(join(dataDir, "makew.db"));
		try {
			expect(before.getDisposition("a-unit")).toBe("accepted");
			expect(before.getDisposition("z-pause")).toBe("accepted");
			expect(
				before
					.getAudit()
					.filter((entry) => entry.event.includes('"type":"runner.started"')),
			).toHaveLength(0);
			expect(before.getCheckpoint()?.snapshot).toContain('"id":"z-pause"');
		} finally {
			before.close();
		}
		await run(process.execPath, [cli, "start"], { env });
		const sent = await run(
			process.execPath,
			[cli, "send", JSON.stringify({ type: "hold.lift", holdId: "z-pause" })],
			{ env },
		);
		const id = sent.stdout.trim();
		for (let i = 0; i < 200 && existsSync(join(inbox, `${id}.json`)); i++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(existsSync(join(inbox, `${id}.json`))).toBe(false);
		for (let i = 0; i < 200; i++) {
			const current = openStore(join(dataDir, "makew.db"));
			const started = current
				.getAudit()
				.some((entry) => entry.event.includes('"type":"runner.started"'));
			current.close();
			if (started) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		await run(process.execPath, [cli, "stop"], { env });
		[worker] = recordedWorkers(dataDir);
		expect(worker && getProcessState(worker)).toBe("alive");
		const after = openStore(join(dataDir, "makew.db"));
		try {
			expect(
				after
					.getAudit()
					.filter((entry) => entry.event.includes('"type":"runner.started"'))
					.length,
			).toBeGreaterThan(0);
		} finally {
			after.close();
		}
	} finally {
		await removeEngineData(dataDir);
	}
	expect(worker && getProcessState(worker)).toBe("dead");
});

test("stop waits until the signalled owner's lock is released", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "makew-stop-wait-"));
	const lockPath = join(dataDir, "engine.lock");
	const marker = join(dataDir, "signalled");
	const fake = join(dataDir, "fake-engine");
	writeFileSync(
		lockPath,
		JSON.stringify({
			pid: process.pid,
			startedAt: "test",
			token: "owner",
			port: 1,
		}),
	);
	writeFileSync(fake, '#!/bin/sh\nprintf yes > "$STOP_MARKER"\n', {
		mode: 0o755,
	});
	const child = spawn(process.execPath, [cli, "stop"], {
		env: {
			...process.env,
			MAKEW_DATA_DIR: dataDir,
			MAKEW_ENGINE: fake,
			STOP_MARKER: marker,
		},
		stdio: "ignore",
	});
	const exit = new Promise<number | undefined>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolve(code ?? undefined));
	});
	try {
		for (let i = 0; i < 200 && !existsSync(marker); i++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(existsSync(marker)).toBe(true);
		const stillWaiting = await Promise.race([
			exit.then(() => false),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 200)),
		]);
		expect(stillWaiting).toBe(true);
		rmSync(lockPath);
		expect(await exit).toBe(0);
	} finally {
		child.kill("SIGKILL");
		rmSync(dataDir, { recursive: true, force: true });
	}
});
