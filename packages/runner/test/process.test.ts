import { ProcessIdentity } from "@makewhether/domain";
import { Schema } from "effect";
import { expect, test } from "vitest";
import {
	classifyProcessOutput,
	getProcessStart,
	getProcessState,
} from "../src/process.ts";

test("matching live identity is alive, but a matching ps zombie is dead", () => {
	const startedAt = getProcessStart(process.pid);
	expect(startedAt).toBeDefined();
	if (!startedAt) throw new Error("could not read current process identity");
	expect(() => process.kill(process.pid, 0)).not.toThrow();
	expect(getProcessState({ pid: process.pid, startedAt })).toBe("alive");
	expect(classifyProcessOutput(`Z ${startedAt}`, startedAt)).toBe("dead");
	expect(classifyProcessOutput(`S ${startedAt}`, startedAt)).toBe("alive");
	expect(classifyProcessOutput(`S ${startedAt}`, "different")).toBe("dead");
	expect(classifyProcessOutput("", startedAt)).toBe("unknown");
});

test("process identity schema rejects unsafe PIDs and empty start times", () => {
	const decode = Schema.decodeUnknownSync(ProcessIdentity);
	expect(decode({ pid: 1, startedAt: "start" })).toEqual({
		pid: 1,
		startedAt: "start",
	});
	for (const pid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
		expect(() => decode({ pid, startedAt: "start" })).toThrow();
	expect(() => decode({ pid: 1, startedAt: "" })).toThrow();
});
