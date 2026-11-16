import { spawn } from "node:child_process";
import { constants } from "node:os";

const test = spawn("vitest", ["run", ...process.argv.slice(2)], {
	detached: true,
	stdio: "inherit",
});

function stop(exitCode) {
	process.exitCode = exitCode;
	if (test.pid == null) return;
	try {
		// Vitest workers share the process group, so stop the whole group.
		process.kill(-test.pid, "SIGKILL");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
			throw error;
	}
}

const deadline = setTimeout(() => {
	process.stderr.write("Vitest exceeded the 60-second suite deadline.\n");
	stop(124);
}, 60_000);

process.once("SIGINT", () => stop(130));
process.once("SIGTERM", () => stop(143));
test.once("error", (error) => {
	clearTimeout(deadline);
	process.stderr.write(`${error.message}\n`);
	process.exitCode = 1;
});
test.once("exit", (code, signal) => {
	clearTimeout(deadline);
	process.exitCode ??= code ?? (signal ? 128 + constants.signals[signal] : 1);
});
