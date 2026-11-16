#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
	accessSync,
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InboxCommand, LockRecord } from "@makewhether/domain";
import { Schema, SchemaIssue } from "effect";
import { ulid } from "ulid";

const defaultDataDir = join(homedir(), ".local", "share", "makewhether");
const dataDir = resolve(
	process.env.MAKEW_DATA_DIR ??
		join(
			process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
			"makewhether",
		),
);
function readEngineLock(): typeof LockRecord.Type | undefined {
	try {
		return Schema.decodeUnknownSync(LockRecord)(
			JSON.parse(readFileSync(join(dataDir, "engine.lock"), "utf8")),
		);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return undefined;
		throw error;
	}
}
function getEnginePath() {
	if (process.env.MAKEW_ENGINE)
		return { command: process.env.MAKEW_ENGINE, prefix: [] };
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		const candidate = join(directory, "makew-engine");
		try {
			accessSync(candidate, 1);
			return { command: candidate, prefix: [] };
		} catch {
			/* Try the next PATH entry. */
		}
	}
	return {
		command: process.execPath,
		prefix: [fileURLToPath(new URL("../../host/src/main.ts", import.meta.url))],
	};
}
const engine = getEnginePath();
class InvalidCommandType extends Error {}
const commandCases = InboxCommand.pipe(Schema.toTaggedUnion("type")).cases;
function isCommandType(value: unknown): value is keyof typeof commandCases {
	return typeof value === "string" && Object.hasOwn(commandCases, value);
}
const [command, ...args] = process.argv.slice(2);
const deciding = command === "unit" && args[0] === "decide";
if (command === "send" || deciding) {
	let body: string | undefined;
	try {
		let parsed: unknown;
		if (deciding) {
			const [, unitId, episode, decisionJson] = args;
			if (unitId === undefined || episode === undefined || args.length > 4)
				throw new InvalidCommandType(
					"Usage: makew unit decide <unit-id> <episode> [decision-json]",
				);
			parsed = {
				type: "unit.decide",
				unitId,
				episode: Number(episode),
				decision: JSON.parse(decisionJson ?? readFileSync(0, "utf8")),
			};
		} else {
			body = args[0] ?? readFileSync(0, "utf8");
			parsed = JSON.parse(body);
		}
		// Select the member so invalid literal fields do not hide the other issues in its union.
		if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed))
			throw new InvalidCommandType("Expected a command object");
		if (!("type" in parsed))
			throw new InvalidCommandType("Missing command type");
		if (!isCommandType(parsed.type))
			throw new InvalidCommandType("Unknown command type");
		Schema.decodeUnknownSync(commandCases[parsed.type], { errors: "all" })(
			parsed,
		);
		body = body ?? JSON.stringify(parsed);
	} catch (error) {
		if (error instanceof SyntaxError)
			process.stderr.write(`Invalid JSON: ${error.message}\n`);
		else if (error instanceof InvalidCommandType)
			process.stderr.write(`["type"]: ${error.message}\n`);
		else if (Schema.isSchemaError(error)) {
			const issues = SchemaIssue.makeFormatterStandardSchemaV1()(
				error.issue,
			).issues;
			for (const issue of issues) {
				const path =
					issue.path?.map((part) =>
						typeof part === "object" ? part.key : part,
					) ?? [];
				process.stderr.write(`${JSON.stringify(path)}: ${issue.message}\n`);
			}
		} else throw error;
		process.exitCode = 1;
		body = undefined;
	}
	if (body !== undefined) {
		const inbox = join(dataDir, "inbox");
		mkdirSync(inbox, { recursive: true });
		const id = ulid();
		const temp = join(inbox, `.${id}.tmp`);
		writeFileSync(temp, body, { flag: "wx", mode: 0o600 });
		renameSync(temp, join(inbox, `${id}.json`));
		process.stdout.write(`${id}\n`);
	}
} else if (
	command === "unit" &&
	(args[0] === "ls" || (args[0] === "show" && args[1]))
) {
	const owner = readEngineLock();
	if (!owner) throw new Error("no engine owns this data directory");
	const endpoint =
		args[0] === "ls"
			? "/units"
			: `/units?${new URLSearchParams({ id: args[1] ?? "" })}`;
	const response = await fetch(`http://127.0.0.1:${owner.port}${endpoint}`, {
		signal: AbortSignal.timeout(5000),
	});
	if (!response.ok) throw new Error(`unit read failed: ${response.status}`);
	process.stdout.write(
		`${JSON.stringify(await response.json(), undefined, 2)}\n`,
	);
} else if (command === "replay" && args[0]) {
	const child = spawn(
		engine.command,
		[...engine.prefix, "replay", resolve(args[0])],
		{ stdio: "inherit", env: { ...process.env, MAKEW_DATA_DIR: dataDir } },
	);
	const code = await new Promise<number>((resolveCode, reject) => {
		child.once("error", reject);
		child.once("exit", (status) => resolveCode(status ?? 1));
	});
	if (code !== 0) process.exitCode = code;
} else if (command === "machine" && args[0] === "check" && args[1]) {
	const child = spawn(
		engine.command,
		[...engine.prefix, "check", resolve(args[1])],
		{ stdio: "inherit" },
	);
	const code = await new Promise<number>((resolveCode, reject) => {
		child.once("error", reject);
		child.once("exit", (status) => resolveCode(status ?? 1));
	});
	if (code !== 0) process.exitCode = code;
} else if (command === "start") {
	mkdirSync(dataDir, { recursive: true });
	let child: ReturnType<typeof spawn> | undefined;
	let exited: number | undefined;
	let spawnError: Error | undefined;
	const service = `gui/${process.getuid?.()}/homebrew.mxcl.makewhether`;
	const managed =
		process.platform === "darwin" &&
		dataDir === defaultDataDir &&
		spawnSync("/bin/launchctl", ["print", service], { stdio: "ignore" })
			.status === 0;
	if (managed) {
		const kicked = spawnSync("/bin/launchctl", ["kickstart", service], {
			stdio: "ignore",
		});
		if (kicked.status !== 0) throw new Error(`cannot start ${service}`);
	} else {
		const log = openSync(join(dataDir, "engine.log"), "a", 0o600);
		child = spawn(
			engine.command,
			[...engine.prefix, "serve", dataDir, process.env.MAKEW_PORT ?? "0"],
			{ detached: true, stdio: ["ignore", log, log] },
		);
		closeSync(log);
		child.once("error", (error) => {
			spawnError = error;
		});
		child.once("exit", (status) => {
			exited = status ?? 1;
		});
	}
	const deadline = Date.now() + 10_000;
	let ready = false;
	while (
		Date.now() < deadline &&
		!ready &&
		exited === undefined &&
		!spawnError
	) {
		try {
			const value = readEngineLock();
			if (value && (managed || value.pid === child?.pid)) {
				const response = await fetch(`http://127.0.0.1:${value.port}/health`, {
					signal: AbortSignal.timeout(250),
				});
				const health: unknown = await response.json();
				ready =
					response.ok &&
					typeof health === "object" &&
					health != null &&
					"pid" in health &&
					health.pid === value.pid &&
					"dataDir" in health &&
					health.dataDir === dataDir;
			}
		} catch {
			/* The engine may not have published its lock yet. */
		}
		if (!ready)
			await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
	}
	if (!ready) {
		if (child && exited === undefined) child.kill("SIGTERM");
		throw new Error(
			`engine failed to start; see ${join(dataDir, "engine.log")}`,
		);
	}
	child?.unref();
} else if (command === "stop") {
	const owner = readEngineLock();
	if (!owner) throw new Error("no engine owns this data directory");
	const child = spawn(
		engine.command,
		[...engine.prefix, "stop", dataDir, owner.token],
		{
			stdio: "inherit",
		},
	);
	const code = await new Promise<number>((resolveCode, reject) => {
		child.once("error", reject);
		child.once("exit", (status) => resolveCode(status ?? 1));
	});
	if (code !== 0) process.exitCode = code;
	else {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline && readEngineLock()?.token === owner.token)
			await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
		if (readEngineLock()?.token === owner.token)
			throw new Error("engine did not release its lock");
	}
} else
	throw new Error(
		"usage: makew start|stop|send|unit ls|unit show|unit decide|replay|machine check",
	);
