import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	linkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runFakeHarness } from "./fake-harness.ts";
import { getProcessStart } from "./process.ts";

const [directory, key, input] = process.argv.slice(2);
if (!directory || !key || !input) throw new Error("missing wrapper arguments");
const pidPath = join(
	directory,
	`${createHash("sha256").update(key).digest("hex")}.pid`,
);
const startedAt = getProcessStart(process.pid);
if (!startedAt) throw new Error("cannot verify wrapper process identity");
const temp = `${pidPath}.${process.pid}.${crypto.randomUUID()}`;
writeFileSync(temp, JSON.stringify({ pid: process.pid, startedAt }), {
	flag: "wx",
});
let claimed = false;
try {
	try {
		linkSync(temp, pidPath);
		claimed = true;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
			throw error;
	}
} finally {
	unlinkSync(temp);
}
if (!claimed || existsSync(`${pidPath}.park`)) process.exit(0);
const output = join(
	directory,
	`${createHash("sha256").update(key).digest("hex")}.jsonl`,
);
await runFakeHarness(input, directory, (value) =>
	appendFileSync(output, `${JSON.stringify(value)}\n`),
);
