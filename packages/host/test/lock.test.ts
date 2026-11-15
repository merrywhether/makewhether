import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { readLock, takeLock } from "../src/lock.ts";

test("lock preserves a live owner, rejects incomplete metadata and recovers stale owners", () => {
	const dir = mkdtempSync(join(tmpdir(), "makew-lock-"));
	const path = join(dir, "engine.lock");
	try {
		const first = takeLock(path, 1234);
		expect(readLock(path)).toEqual(first.owner);
		expect(() => takeLock(path, 1235)).toThrow("another engine");
		first.release();
		writeFileSync(
			path,
			JSON.stringify({
				...first.owner,
				startedAt: "wrong-start-time",
				token: "recycled",
			}),
		);
		const recycled = takeLock(path, 1235);
		expect(readLock(path)).toEqual(recycled.owner);
		recycled.release();
		writeFileSync(
			path,
			JSON.stringify({ pid: -1, startedAt: "bad", port: 1, token: "bad" }),
		);
		expect(readLock(path)).toBeUndefined();
		expect(() => takeLock(path, 1235)).toThrow("another engine");
		rmSync(path);
		writeFileSync(path, "");
		expect(() => takeLock(path, 1235)).toThrow("another engine");
		expect(readFileSync(path, "utf8")).toBe("");
		rmSync(path);
		const stale = JSON.stringify({
			pid: 2147483647,
			startedAt: "old",
			port: 1,
			token: "old",
		});
		writeFileSync(path, stale);
		const digest = createHash("sha256")
			.update(path)
			.update("\0")
			.update(stale)
			.digest("hex");
		writeFileSync(
			join(dir, `.reclaim-${digest}`),
			JSON.stringify({
				pid: 2147483646,
				startedAt: "older",
				port: 1,
				token: "dead-claim",
			}),
		);
		const replacement = takeLock(path, 1235);
		expect(readLock(path)).toEqual(replacement.owner);
		first.release();
		expect(readLock(path)).toEqual(replacement.owner);
		replacement.release();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("concurrent stale contenders elect one owner and a SIGKILL leaves a recoverable lock", async () => {
	const dir = mkdtempSync(join(tmpdir(), "makew-lock-race-"));
	const path = join(dir, "engine.lock");
	const alias = `${dir}-alias`;
	symlinkSync(dir, alias);
	const moduleUrl = pathToFileURL(
		join(import.meta.dirname, "../src/lock.ts"),
	).href;
	const source = `import { takeLock } from ${JSON.stringify(moduleUrl)}; try { takeLock(process.argv[1], 4); console.log('won'); setInterval(() => {}, 1000); } catch { console.log('lost'); }`;
	writeFileSync(
		path,
		JSON.stringify({
			pid: 2147483647,
			startedAt: "old",
			port: 1,
			token: "old",
		}),
	);
	const children = [path, join(alias, "engine.lock")].map((lockPath) =>
		spawn(process.execPath, ["--input-type=module", "-e", source, lockPath], {
			stdio: ["ignore", "pipe", "pipe"],
		}),
	);
	try {
		const outcomes = await Promise.all(
			children.map(
				(child) =>
					new Promise<string>((resolve, reject) => {
						child.stdout.once("data", (chunk: Buffer) =>
							resolve(chunk.toString().trim()),
						);
						child.once("error", reject);
						child.once("exit", (code) => {
							if (code && code !== 0) reject(new Error(`child exited ${code}`));
						});
					}),
			),
		);
		expect(outcomes.sort()).toEqual(["lost", "won"]);
		const winner = children.find((child) => child.pid === readLock(path)?.pid);
		expect(winner).toBeDefined();
		if (!winner) throw new Error("missing lock owner");
		const exited = new Promise<void>((resolve) =>
			winner.once("exit", () => resolve()),
		);
		winner.kill("SIGKILL");
		await exited;
		const next = takeLock(path, 5);
		expect(readLock(path)).toEqual(next.owner);
		next.release();
	} finally {
		for (const child of children) child.kill("SIGKILL");
		rmSync(alias, { force: true });
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a stale recovery claim is shared across directory aliases", () => {
	const dir = mkdtempSync(join(tmpdir(), "makew-lock-alias-"));
	const alias = `${dir}-alias`;
	symlinkSync(dir, alias);
	const canonical = join(realpathSync(dir), "engine.lock");
	const throughAlias = join(alias, "engine.lock");
	const guard = takeLock(join(dir, "guard.lock"), 10);
	const stale = JSON.stringify({
		pid: 2147483647,
		startedAt: "old",
		port: 1,
		token: "old",
	});
	const digest = createHash("sha256")
		.update(canonical)
		.update("\0")
		.update(stale)
		.digest("hex");
	const claim = join(dir, `.reclaim-${digest}`);
	try {
		writeFileSync(canonical, stale);
		writeFileSync(claim, JSON.stringify(guard.owner));
		expect(() => takeLock(throughAlias, 11)).toThrow("another engine");
		expect(readFileSync(canonical, "utf8")).toBe(stale);
		rmSync(claim);
		const next = takeLock(throughAlias, 11);
		next.release();
	} finally {
		guard.release();
		rmSync(alias, { force: true });
		rmSync(dir, { recursive: true, force: true });
	}
});
