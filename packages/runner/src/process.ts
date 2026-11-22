import { execFileSync } from "node:child_process";
import type { ProcessIdentity } from "@makewhether/domain";

export type { ProcessIdentity } from "@makewhether/domain";

function processDetails(pid: number): string | undefined {
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	try {
		return (
			execFileSync("ps", ["-o", "state=", "-o", "lstart=", "-p", String(pid)], {
				encoding: "utf8",
				env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() || undefined
		);
	} catch {
		return undefined;
	}
}
function parseDetails(
	output: string,
): { state: string; startedAt: string } | undefined {
	const match = /^(\S+)\s+(.+)$/.exec(output.trim());
	return match?.[1] && match[2]
		? { state: match[1], startedAt: match[2] }
		: undefined;
}
/** Classify a ps observation after the PID has passed the signal-zero check. */
export function classifyProcessOutput(
	output: string,
	startedAt: string,
): "alive" | "dead" | "unknown" {
	const actual = parseDetails(output);
	if (!actual) return "unknown";
	return actual.state.startsWith("Z") || actual.startedAt !== startedAt
		? "dead"
		: "alive";
}
export function getProcessStart(pid: number): string | undefined {
	const output = processDetails(pid);
	return output ? parseDetails(output)?.startedAt : undefined;
}
export function getProcessState(
	identity: ProcessIdentity,
): "alive" | "dead" | "unknown" {
	if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0)
		return "unknown";
	try {
		process.kill(identity.pid, 0);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH")
			return "dead";
		return "unknown";
	}
	const output = processDetails(identity.pid);
	if (!output) {
		try {
			process.kill(identity.pid, 0);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ESRCH")
				return "dead";
		}
		return "unknown";
	}
	return classifyProcessOutput(output, identity.startedAt);
}
