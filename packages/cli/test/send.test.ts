import { spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const cli = join(import.meta.dirname, "../src/main.ts");

async function send(dataDir: string, body: string, positional: boolean) {
	const child = spawn(
		process.execPath,
		[cli, "send", ...(positional ? [body] : [])],
		{
			env: { ...process.env, MAKEW_DATA_DIR: dataDir },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	const exit = new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? 1));
	});
	child.stdin.end(positional ? "" : body);
	return { code: await exit, stdout, stderr };
}

test.each([false, true])(
	"send accepts %s positional input",
	async (positional) => {
		const dir = mkdtempSync(join(tmpdir(), "makew-send-"));
		try {
			const body = JSON.stringify({ type: "hold.lift", holdId: "hold" });
			const result = await send(dir, body, positional);
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			const id = result.stdout.trim();
			expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
			expect(
				JSON.parse(readFileSync(join(dir, "inbox", `${id}.json`), "utf8")),
			).toEqual(JSON.parse(body));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

test.each([
	[
		"multiple fields",
		'{"type":"hold.add","kind":4,"mode":5,"scope":8}',
		['["kind"]', '["mode"]', '["scope"]'],
	],
	[
		"nested fields",
		'{"type":"hold.add","kind":"pause","mode":"hard","scope":{"kind":"model","account":4,"model":5}}',
		['["scope","account"]', '["scope","model"]'],
	],
	["unknown type", '{"type":"typo"}', ['["type"]']],
	["malformed JSON", "{", ["Invalid JSON:"]],
] as const)(
	"send reports %s without writing a command",
	async (_name, body, paths) => {
		const dir = mkdtempSync(join(tmpdir(), "makew-send-invalid-"));
		try {
			const result = await send(dir, body, false);
			expect(result.code).not.toBe(0);
			expect(result.stdout).toBe("");
			for (const path of paths) expect(result.stderr).toContain(path);
			expect(result.stderr).not.toContain("\n    at ");
			const inbox = join(dir, "inbox");
			expect(existsSync(inbox) ? readdirSync(inbox) : []).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
