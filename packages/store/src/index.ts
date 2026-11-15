import { DatabaseSync } from "node:sqlite";

export type Checkpoint = {
	machine: string;
	version: string;
	snapshot: string;
	at: number;
};
export type LogEntry = {
	at: number;
	kind: "inbox" | "transition" | "rejected";
	key: string;
	event: string;
	address: string;
};

/** Open the single-writer checkpoint and audit store. */
export function openStore(path: string) {
	const database = new DatabaseSync(path);
	database.exec(`
		PRAGMA journal_mode = WAL;
		CREATE TABLE IF NOT EXISTS checkpoint (id INTEGER PRIMARY KEY CHECK (id = 1), machine TEXT NOT NULL, version TEXT NOT NULL, snapshot TEXT NOT NULL, at INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS consumed (key TEXT PRIMARY KEY, at INTEGER NOT NULL, disposition TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, event TEXT NOT NULL, address TEXT NOT NULL);
	`);
	const writeCheckpoint = database.prepare(
		"INSERT OR REPLACE INTO checkpoint (id, machine, version, snapshot, at) VALUES (1, ?, ?, ?, ?)",
	);
	const writeLog = database.prepare(
		"INSERT INTO audit (at, kind, key, event, address) VALUES (?, ?, ?, ?, ?)",
	);
	const markConsumed = database.prepare(
		"INSERT INTO consumed (key, at, disposition) VALUES (?, ?, ?)",
	);
	return {
		getCheckpoint(): Checkpoint | undefined {
			const row = database
				.prepare(
					"SELECT machine, version, snapshot, at FROM checkpoint WHERE id = 1",
				)
				.get();
			if (!row) return undefined;
			if (
				typeof row.machine !== "string" ||
				typeof row.version !== "string" ||
				typeof row.snapshot !== "string" ||
				typeof row.at !== "number"
			)
				throw new Error("invalid checkpoint row");
			return {
				machine: row.machine,
				version: row.version,
				snapshot: row.snapshot,
				at: row.at,
			};
		},
		getDisposition(key: string): "accepted" | "rejected" | undefined {
			const row = database
				.prepare("SELECT disposition FROM consumed WHERE key = ?")
				.get(key);
			if (!row) return undefined;
			if (row.disposition !== "accepted" && row.disposition !== "rejected")
				throw new Error("invalid inbox disposition");
			return row.disposition;
		},
		commit(
			checkpoint: Checkpoint,
			entries: readonly LogEntry[],
			consumed?: {
				key: string;
				at: number;
				disposition: "accepted" | "rejected";
			},
		): void {
			database.exec("BEGIN IMMEDIATE");
			try {
				writeCheckpoint.run(
					checkpoint.machine,
					checkpoint.version,
					checkpoint.snapshot,
					checkpoint.at,
				);
				for (const entry of entries)
					writeLog.run(
						entry.at,
						entry.kind,
						entry.key,
						entry.event,
						entry.address,
					);
				if (consumed)
					markConsumed.run(consumed.key, consumed.at, consumed.disposition);
				database.exec("COMMIT");
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		},
		getAudit(): readonly LogEntry[] {
			return database
				.prepare("SELECT at, kind, key, event, address FROM audit ORDER BY seq")
				.all()
				.map((row) => {
					if (
						typeof row.at !== "number" ||
						(row.kind !== "inbox" &&
							row.kind !== "transition" &&
							row.kind !== "rejected") ||
						typeof row.key !== "string" ||
						typeof row.event !== "string" ||
						typeof row.address !== "string"
					)
						throw new Error("invalid audit row");
					return {
						at: row.at,
						kind: row.kind,
						key: row.key,
						event: row.event,
						address: row.address,
					};
				});
		},
		close(): void {
			database.close();
		},
	};
}
export type Store = ReturnType<typeof openStore>;
