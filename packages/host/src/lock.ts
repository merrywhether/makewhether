import { createHash, randomUUID } from "node:crypto";
import {
	linkSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { LockRecord } from "@makewhether/domain";
import { getProcessStart, getProcessState } from "@makewhether/runner";
import { Schema } from "effect";

export type { LockRecord } from "@makewhether/domain";

function read(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return undefined;
		throw error;
	}
}

function parse(raw: string): LockRecord | undefined {
	try {
		return Schema.decodeUnknownSync(LockRecord)(JSON.parse(raw));
	} catch {
		return undefined;
	}
}

function publish(path: string, contents: string): boolean {
	const temporary = join(dirname(path), `.lock-${randomUUID()}`);
	writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
	try {
		linkSync(temporary, path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST")
			return false;
		throw error;
	} finally {
		unlinkSync(temporary);
	}
}

function reclaim(path: string, raw: string, owner: LockRecord): boolean {
	const stale = parse(raw);
	if (!stale || getProcessState(stale) !== "dead") return false;
	const digest = createHash("sha256")
		.update(path)
		.update("\0")
		.update(raw)
		.digest("hex");
	const claim = join(dirname(path), `.reclaim-${digest}`);
	const claimContents = JSON.stringify(owner);
	if (!publish(claim, claimContents)) {
		const previous = read(claim);
		if (previous !== undefined && reclaim(claim, previous, owner))
			return reclaim(path, raw, owner);
		return false;
	}
	try {
		if (read(path) !== raw) return false;
		unlinkSync(path);
		return true;
	} finally {
		if (read(claim) === claimContents) unlinkSync(claim);
	}
}

/** Claim the engine lock and return a release function. */
export function takeLock(requestedPath: string, port: number) {
	const path = join(
		realpathSync(dirname(requestedPath)),
		basename(requestedPath),
	);
	const startedAt = getProcessStart(process.pid);
	if (!startedAt) throw new Error("cannot determine engine process start time");
	const owner: LockRecord = {
		pid: process.pid,
		startedAt,
		token: randomUUID(),
		port,
	};
	const contents = JSON.stringify(owner);
	for (;;) {
		if (publish(path, contents))
			return {
				owner,
				release(): void {
					if (read(path) === contents) unlinkSync(path);
				},
			};
		const existing = read(path);
		if (existing === undefined) continue;
		if (!reclaim(path, existing, owner))
			throw new Error("another engine owns the lock");
	}
}

/** Read an engine lock without treating incomplete metadata as stale. */
export function readLock(path: string): LockRecord | undefined {
	const raw = read(path);
	return raw === undefined ? undefined : parse(raw);
}

/** Check the engine process identity recorded in a lock. */
export function isLockOwnerAlive(owner: LockRecord): boolean {
	return getProcessState(owner) !== "dead";
}

/** Verify a live engine's process start identity before signalling it. */
export function isLockOwnerVerified(owner: LockRecord): boolean {
	return (
		Number.isSafeInteger(owner.pid) &&
		owner.pid > 0 &&
		getProcessState(owner) === "alive"
	);
}
