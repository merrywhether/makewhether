import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RunnerInput } from "@makewhether/domain";
import { Schema } from "effect";
import { getProcessStart } from "./process.ts";

export async function runFakeHarness(
	raw: string,
	directory: string,
	line: (value: unknown) => void,
): Promise<void> {
	const decoded: unknown = JSON.parse(raw);
	if (
		typeof decoded !== "object" ||
		decoded == null ||
		!("spec" in decoded) ||
		typeof decoded.spec !== "object" ||
		decoded.spec == null
	)
		throw new Error("invalid harness input");
	const input = Schema.decodeUnknownSync(RunnerInput)({
		...decoded,
		resume: "resume" in decoded ? decoded.resume : undefined,
		spec: {
			...decoded.spec,
			prior: "prior" in decoded.spec ? decoded.spec.prior : undefined,
		},
	});
	const plans: Record<
		string,
		{ outcome?: string; delayMs?: number; resetMs?: number }
	> = JSON.parse(process.env.MAKEW_FAKE_PLAN ?? "{}");
	const plan = plans[input.key] ?? {};
	const log = (value: unknown) =>
		appendFileSync(join(directory, "runs.jsonl"), `${JSON.stringify(value)}\n`);

	log({
		type: "start",
		mode: input.resume ? "resume" : "fresh",
		key: input.key,
		at: Date.now(),
		resume: input.resume,
		pid: process.pid,
		startedAt: getProcessStart(process.pid),
	});
	line({
		type: "thread.started",
		thread_id: input.resume ?? crypto.randomUUID(),
	});
	line({ type: "turn.started" });
	await new Promise((resolve) => setTimeout(resolve, plan.delayMs ?? 0));
	if (plan.outcome === "quota") {
		line({
			type: "turn.failed",
			error: {
				kind: "quota",
				message: "You have hit your usage limit. Try again later.",
				resetsAt: Date.now() + (plan.resetMs ?? 1000),
			},
		});
	} else if (plan.outcome === "error") {
		line({
			type: "turn.failed",
			error: { kind: "error", message: "fake error", detail: "fake error" },
		});
	} else {
		line({
			type: "item.completed",
			item: {
				type: "agent_message",
				text: JSON.stringify({
					kind: "done",
					verdict: input.spec.phase === "implement" ? "done" : "pass",
					detail: "fake worker",
				}),
			},
		});
		line({ type: "turn.completed" });
	}
	log({
		type: "answer",
		key: input.key,
		at: Date.now(),
		path: join(
			directory,
			`${createHash("sha256").update(input.key).digest("hex")}.jsonl`,
		),
		outcome: plan.outcome ?? "done",
	});
}
if (
	process.argv[1] &&
	pathToFileURL(process.argv[1]).href === import.meta.url
) {
	const [raw, directory] = process.argv.slice(2);
	if (!raw || !directory) throw new Error("missing harness arguments");
	await runFakeHarness(raw, directory, (value) => {
		process.stdout.write(`${JSON.stringify(value)}\n`);
	});
}
