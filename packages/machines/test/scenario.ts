import type { Routes, WorkerReport } from "@makewhether/domain";
import type { Script } from "./workers.ts";

const agent = { harness: "codex", model: "agent", account: "pro" } as const;
const first = { harness: "codex", model: "first", account: "pro" } as const;
const second = { harness: "codex", model: "second", account: "pro" } as const;
const shell = { harness: "shell", model: "shell", account: "local" } as const;
const person = {
	harness: "person",
	model: "person",
	account: "person",
} as const;
export const makeRoutes = (fallback = false): Routes => ({
	implement: [
		{
			tier: "implementer",
			workers: fallback ? [first, second] : [agent],
			rules: {},
		},
	],
	verify: [{ tier: "script", workers: [shell], rules: {} }],
	judge: [{ tier: "judge", workers: [agent], rules: {} }],
	intervene: [
		{ tier: "agent", workers: [agent], rules: {} },
		{ tier: "person", workers: [person], rules: {} },
	],
});

const report = (
	verdict: "done" | "pass" | "findings" | "unsure",
): WorkerReport => ({
	kind: "done",
	verdict,
	detail: verdict,
});

export const script: Script = (input, prior, now) => {
	const unit = input.spec.taskId.split("/")[0];
	const limit = unit === "A" && input.spec.phase === "implement" && prior === 0;
	const duration = limit
		? 10_000
		: input.spec.phase === "implement"
			? 20_000
			: 10_000;
	if (limit)
		return {
			duration,
			event: {
				type: "runner.limit",
				holdId: "quota",
				scope: { kind: "account", account: "pro" },
				at: now + duration,
				resetsAt: now + duration + 30_000,
			},
		};
	const verdict =
		input.spec.phase === "implement"
			? "done"
			: input.spec.phase === "verify"
				? "pass"
				: input.spec.phase === "intervene"
					? "unsure"
					: (unit === "B" && prior === 0) || (unit === "C" && prior < 2)
						? "findings"
						: "pass";
	return {
		duration,
		event: { type: "runner.report", outcome: report(verdict) },
	};
};
