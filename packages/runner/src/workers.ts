import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	ProcessIdentity,
	type RunnerEvent,
	type RunnerInput,
	WorkerReport,
} from "@makewhether/domain";
import { Clock, Effect, Schema, type Scope } from "effect";
import { getProcessState } from "./process.ts";

function readText(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return "";
		throw error;
	}
}
function identity(path: string): ProcessIdentity | undefined {
	try {
		return Schema.decodeUnknownSync(ProcessIdentity)(
			JSON.parse(readFileSync(path, "utf8")),
		);
	} catch {
		return undefined;
	}
}

/** Process records belong to detached wrappers, so they survive the engine. */
export function createProcessWorkers(options: { dataDir: string }) {
	const directory = join(options.dataDir, "runs");
	mkdirSync(directory, { recursive: true });
	let stopping = false;
	let open = () => {};
	const gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	return {
		openGate: () => open(),
		shutdown: () => {
			stopping = true;
		},
		run(
			input: RunnerInput,
			emit: (event: RunnerEvent) => void,
		): Effect.Effect<void, never, Scope.Scope> {
			return Effect.gen(function* () {
				const stem = join(
					directory,
					createHash("sha256").update(input.key).digest("hex"),
				);
				const pidPath = `${stem}.pid`;
				const outputPath = `${stem}.jsonl`;
				let terminal = false;
				let spawned = false;
				let spawnEnded = false;
				let observed = false;
				const recordMode = (mode: "reattach" | "replay", at: number) => {
					if (!spawned && !observed)
						appendFileSync(
							join(directory, "runs.jsonl"),
							`${JSON.stringify({ type: mode, key: input.key, at, path: outputPath })}\n`,
						);
					observed = true;
				};
				let session: string | undefined;
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						if (stopping || terminal) return;
						if (spawned || existsSync(pidPath))
							writeFileSync(`${pidPath}.park`, "parked");
						const owner = identity(pidPath);
						if (owner && getProcessState(owner) === "alive") {
							try {
								process.kill(-owner.pid, "SIGTERM");
							} catch {
								/* already exited */
							}
						}
					}),
				);
				while (true) {
					const now = yield* Clock.currentTimeMillis;
					const content = readText(outputPath);
					const lines = content.split("\n").slice(0, -1);
					let report: typeof WorkerReport.Type | undefined;
					let failure:
						| { kind: string; detail?: string; resetsAt?: number; raw: string }
						| undefined;
					let completed = false;
					for (const line of lines) {
						let event: {
							type?: string;
							thread_id?: unknown;
							item?: { type?: string; text?: string };
							error?: { kind?: string; detail?: string; resetsAt?: number };
						};
						try {
							const parsed: unknown = JSON.parse(line);
							if (typeof parsed !== "object" || parsed == null) continue;
							event = parsed;
						} catch {
							continue;
						}
						if (
							event.type === "thread.started" &&
							typeof event.thread_id === "string" &&
							!session
						) {
							session = event.thread_id;
							emit({ type: "runner.started", sessionId: session });
						}
						if (
							event.type === "item.completed" &&
							event.item?.type === "agent_message"
						) {
							try {
								report = Schema.decodeUnknownSync(WorkerReport)(
									JSON.parse(event.item.text ?? ""),
								);
							} catch {
								/* incomplete or invalid report */
							}
						}
						if (event.type === "turn.completed") completed = true;
						if (
							event.type === "turn.failed" &&
							typeof event.error?.kind === "string"
						)
							failure = { ...event.error, kind: event.error.kind, raw: line };
					}
					if (failure) {
						recordMode("replay", now);
						terminal = true;
						const evidence = join(options.dataDir, "evidence.jsonl");
						const entry = JSON.stringify({
							key: input.key,
							path: outputPath,
							raw: failure.raw,
						});
						if (!readText(evidence).split("\n").includes(entry))
							appendFileSync(evidence, `${entry}\n`);
						if (
							failure.kind === "quota" &&
							typeof failure.resetsAt === "number"
						)
							emit({
								type: "runner.limit",
								holdId: `quota:${input.key}`,
								scope: { kind: "account", account: input.worker.account },
								at: yield* Clock.currentTimeMillis,
								resetsAt: failure.resetsAt,
							});
						else
							emit({
								type: "runner.failed",
								reason: "crashed",
								detail: failure.detail ?? "worker error",
							});
						return;
					}
					if (completed && report) {
						recordMode("replay", now);
						terminal = true;
						emit({ type: "runner.report", outcome: report });
						return;
					}
					if (existsSync(pidPath)) {
						const owner = identity(pidPath);
						const state = owner ? getProcessState(owner) : "unknown";
						if (state === "unknown") {
							terminal = true;
							emit({
								type: "runner.report",
								outcome: {
									kind: "failed",
									detail: "Cannot verify worker process identity",
								},
							});
							return;
						}
						if (state === "alive") recordMode("reattach", now);
						if (state === "dead") {
							if (readText(outputPath) !== content) continue;
							if (existsSync(`${pidPath}.park`)) {
								yield* Effect.promise(() => gate);
								terminal = true;
								emit({ type: "runner.parked" });
								return;
							}
							terminal = true;
							emit({
								type: "runner.failed",
								reason: "lost",
								detail: "Worker process stopped",
							});
							return;
						}
					} else if (content && !spawned) {
						terminal = true;
						emit({
							type: "runner.failed",
							reason: "lost",
							detail: "Worker record ended without a result",
						});
						return;
					} else if (spawned && spawnEnded && !content) {
						terminal = true;
						emit({
							type: "runner.report",
							outcome: {
								kind: "failed",
								detail: "Wrapper exited before publishing a run claim",
							},
						});
						return;
					} else if (!spawned && !content) {
						yield* Effect.promise(() => gate);
						// Avoid a spare wrapper if another one claimed the run during the drain.
						if (existsSync(pidPath) || existsSync(outputPath)) continue;
						const child = spawn(
							process.execPath,
							[
								join(import.meta.dirname, "wrapper.ts"),
								directory,
								input.key,
								JSON.stringify(input),
							],
							{ detached: true, stdio: "ignore" },
						);
						child.on("error", () => {
							spawnEnded = true;
						});
						child.on("exit", () => {
							spawnEnded = true;
						});
						child.unref();
						spawned = true;
					}
					yield* Effect.sleep(25);
				}
			});
		},
	};
}
