import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ProcessIdentity } from "@makewhether/domain";
import { getProcessState } from "@makewhether/runner";
import { Schema } from "effect";
import { readLock } from "../src/lock.ts";

const decodeIdentity = Schema.decodeUnknownSync(ProcessIdentity);

/** A wrapper publishes its PID record before writing any run output. */
export function recordedWorkers(dataDir: string) {
	const runs = join(dataDir, "runs");
	if (!existsSync(runs)) return [];
	return readdirSync(runs)
		.filter((name) => name.endsWith(".pid"))
		.map((name) =>
			decodeIdentity(JSON.parse(readFileSync(join(runs, name), "utf8"))),
		);
}

async function stopProcess(owner: ProcessIdentity) {
	const deadline = Date.now() + 2000;
	let signalled = false;
	while (Date.now() < deadline) {
		const state = getProcessState(owner);
		if (state === "dead") return;
		if (state === "alive" && !signalled) {
			try {
				process.kill(owner.pid, "SIGKILL");
			} catch (error) {
				if (
					!(error instanceof Error && "code" in error && error.code === "ESRCH")
				)
					throw error;
			}
			signalled = true;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`test process ${owner.pid} did not exit`);
}

/** Stop record writers before deleting an executable test's data directory. */
export async function removeEngineData(dataDir: string) {
	const engine = readLock(join(dataDir, "engine.lock"));
	if (engine) await stopProcess(engine);
	await Promise.all(recordedWorkers(dataDir).map(stopProcess));
	rmSync(dataDir, { recursive: true, force: true });
}
