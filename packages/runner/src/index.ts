import type { RunnerEvent, RunnerInput } from "@makewhether/domain";
import { Effect, type Scope } from "effect";

/** Create fake workers that wait for the host's first inbox drain. */
export function createFakeWorkers() {
	let open: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	return {
		openGate(): void {
			open();
		},
		run(
			input: RunnerInput,
			emit: (event: RunnerEvent) => void,
		): Effect.Effect<void, never, Scope.Scope> {
			return Effect.gen(function* () {
				yield* Effect.promise(() => gate);
				emit({ type: "runner.started", sessionId: `fake:${input.key}` });
				emit({
					type: "runner.report",
					outcome: {
						kind: "done",
						verdict: input.spec.phase === "implement" ? "done" : "pass",
						detail: "fake worker",
					},
				});
			});
		},
	};
}

export type { ProcessIdentity } from "./process.ts";
export { getProcessStart, getProcessState } from "./process.ts";
export { createProcessWorkers } from "./workers.ts";
