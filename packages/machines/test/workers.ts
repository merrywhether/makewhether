import { Clock, Effect } from "effect";
import type { RunnerEvent, RunnerInput } from "../src/runner.ts";

export type Process = {
	input: RunnerInput;
	session: string;
	started: number;
	ended: number;
	stopped: number | undefined;
	event: RunnerEvent;
};
export type Script = (
	input: RunnerInput,
	prior: number,
	now: number,
) => { duration: number; event: RunnerEvent };

/** Make a scripted world whose processes survive a simulated engine crash. */
export function createWorld(
	script: Script,
	options?: { waitForStart?: (input: RunnerInput) => Effect.Effect<void> },
) {
	const processes: Process[] = [];
	const calls: {
		input: RunnerInput;
		mode: "start" | "reattach" | "replay" | "lost";
	}[] = [];
	const world = {
		processes,
		calls,
		crashing: false,
		workers: {
			run: (input: RunnerInput, emit: (event: RunnerEvent) => void) =>
				Effect.gen(function* () {
					let now = yield* Clock.currentTimeMillis;
					let process = processes.find((item) => item.input.key === input.key);
					let mode: "start" | "reattach" | "replay" | "lost";
					if (process)
						mode =
							process.stopped !== undefined
								? "lost"
								: process.ended <= now
									? "replay"
									: "reattach";
					else {
						if (options?.waitForStart) yield* options.waitForStart(input);
						now = yield* Clock.currentTimeMillis;
						const unit = input.spec.taskId.split("/")[0];
						const prior = processes.filter(
							(item) =>
								item.input.spec.taskId.startsWith(`${unit}/`) &&
								item.input.spec.phase === input.spec.phase,
						).length;
						const { duration, event } = script(input, prior, now);
						process = {
							input,
							session: input.resume ?? `session:${input.key}`,
							started: now,
							ended: now + duration,
							stopped: undefined,
							event,
						};
						processes.push(process);
						mode = "start";
					}
					const current = process;
					calls.push({ input, mode });
					let finished = false;
					yield* Effect.addFinalizer(() =>
						Effect.gen(function* () {
							if (!finished && !world.crashing && current.stopped === undefined)
								current.stopped = yield* Clock.currentTimeMillis;
						}),
					);
					emit({ type: "runner.started", sessionId: current.session });
					if (mode === "lost") {
						finished = true;
						emit({
							type: "runner.failed",
							reason: "lost",
							detail: "worker stopped",
						});
						return;
					}
					yield* Effect.sleep(Math.max(0, current.ended - now));
					finished = true;
					if (current.event.type === "runner.limit") {
						const at = yield* Clock.currentTimeMillis;
						emit({ ...current.event, at });
					} else emit(current.event);
				}),
		},
	};
	return world;
}
