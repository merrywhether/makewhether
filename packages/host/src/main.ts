#!/usr/bin/env node
import { mkdirSync, watch } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { loadSettings } from "@makewhether/config";
import { readUnits } from "@makewhether/machines";
import { createProcessWorkers } from "@makewhether/runner";
import { openStore } from "@makewhether/store";
import { Effect } from "effect";
import { checkMachine } from "./check.ts";
import { openEngine, Workers } from "./engine.ts";
import { isLockOwnerVerified, readLock, takeLock } from "./lock.ts";
import { replay } from "./replay.ts";

const version = "0.0.0";
const [mode, directory, requestedPort] = process.argv.slice(2);
if (
	!directory ||
	(mode !== "serve" && mode !== "stop" && mode !== "check" && mode !== "replay")
)
	throw new Error("usage: engine serve|stop|check|replay <path> [port]");
const dataDir = resolve(directory);
const lockPath = join(dataDir, "engine.lock");

if (mode === "replay") {
	const result = await replay(dataDir, process.env.MAKEW_DATA_DIR);
	process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`);
} else if (mode === "check") {
	const errors = await checkMachine(dataDir, process.env.MAKEW_CONFIG);
	for (const error of errors) process.stderr.write(`error: ${error}\n`);
	if (errors.length) process.exitCode = 1;
	else process.stdout.write("machine check passed\n");
} else if (mode === "stop") {
	const owner = readLock(lockPath);
	if (!owner || owner.token !== requestedPort || !isLockOwnerVerified(owner))
		throw new Error("no verified engine owns this data directory");
	process.kill(owner.pid, "SIGTERM");
} else {
	let ready = false;
	let stopping = false;
	let wake: (() => void) | undefined;
	let getUnits: (() => ReturnType<typeof readUnits>) | undefined;
	const stop = () => {
		stopping = true;
		ready = false;
		wake?.();
	};
	process.once("SIGTERM", stop);
	mkdirSync(dataDir, { recursive: true });
	const server = createServer((request, response) => {
		if (request.method === "GET" && request.url === "/health") {
			response.writeHead(ready ? 200 : 503, {
				"content-type": "application/json",
			});
			response.end(JSON.stringify({ dataDir, pid: process.pid, version }));
		} else if (
			request.method === "GET" &&
			request.url?.startsWith("/units") &&
			ready &&
			getUnits
		) {
			try {
				const url = new URL(request.url, "http://localhost");
				const units = getUnits();
				const id = url.searchParams.get("id");
				const value =
					url.pathname === "/units"
						? id == null
							? units.filter((unit) => !unit.verdict)
							: units.find((unit) => unit.id === id)
						: undefined;
				response.writeHead(value ? 200 : 404, {
					"content-type": "application/json",
				});
				response.end(JSON.stringify(value ?? { error: "unit not found" }));
			} catch {
				response.writeHead(400);
				response.end("invalid request");
			}
		} else {
			response.writeHead(404);
			response.end();
		}
	});
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(Number(requestedPort ?? 0), "127.0.0.1", () =>
			resolveListen(),
		);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("engine listener has no port");
	let lock: ReturnType<typeof takeLock> | undefined;
	try {
		if (stopping) {
			await new Promise<void>((resolveClose) =>
				server.close(() => resolveClose()),
			);
			process.exit(0);
		}
		lock = takeLock(lockPath, address.port);
		const store = openStore(join(dataDir, "makew.db"));
		const workers = createProcessWorkers({ dataDir });
		try {
			const settings = await loadSettings(process.env.MAKEW_CONFIG);
			await Effect.runPromise(
				Effect.gen(function* () {
					const inbox = join(dataDir, "inbox");
					const engine = yield* openEngine({
						inbox,
						store,
						resolveSettings: () => settings,
					});
					getUnits = () => readUnits(engine.actor.getSnapshot());
					let changed = true;
					const signal = () => {
						changed = true;
						wake?.();
					};
					const watcher = watch(inbox, signal);
					watcher.on("error", signal);
					const timer = setInterval(signal, 5_000);
					try {
						if (!stopping) yield* engine.drain;
						if (!stopping) {
							workers.openGate();
							ready = true;
						}
						while (!stopping) {
							if (!changed)
								yield* Effect.promise(
									() =>
										new Promise<void>((resolveWake) => {
											wake = resolveWake;
										}),
								);
							wake = undefined;
							changed = false;
							if (!stopping) yield* engine.drain;
						}
						workers.shutdown();
						engine.close();
					} finally {
						clearInterval(timer);
						watcher.close();
					}
				}).pipe(Effect.scoped, Effect.provideService(Workers, workers)),
			);
		} finally {
			store.close();
		}
	} finally {
		process.off("SIGTERM", stop);
		try {
			await new Promise<void>((resolveClose, reject) =>
				server.close((error) => (error ? reject(error) : resolveClose())),
			);
		} finally {
			lock?.release();
		}
	}
}
