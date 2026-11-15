import {
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { getUnitSettings } from "@makewhether/config";
import {
	type InboxCommand as Command,
	InboxCommand,
	TaskSpec,
	Worker,
} from "@makewhether/domain";
import {
	unitMachineNames,
	validateWorkspaceEvent,
	Workers,
	workspace,
} from "@makewhether/machines";
import type { Checkpoint, LogEntry, Store } from "@makewhether/store";
import {
	createEffectActor,
	EventRejectedError,
	sendAndAwait,
} from "@xstate/effect";
import { Clock, Effect, Schema } from "effect";
import type { Snapshot } from "xstate";

const StartedContext = Schema.Struct({
	spec: TaskSpec,
	worker: Schema.UndefinedOr(Worker),
});
const isUnitMachine = (value: string) =>
	unitMachineNames.some((name) => name === value);
const decodeCommand = Schema.decodeUnknownSync(InboxCommand);
const decodeStartedContext = Schema.decodeUnknownSync(StartedContext);

type CapturePoint = "after-send" | "before-checkpoint";
type Options = {
	inbox: string;
	store: Store;
	captureHook?: (point: CapturePoint) => void;
	resolveSettings?: (
		command: Extract<Command, { type: "unit.add" }>,
	) => ReturnType<typeof getUnitSettings>;
};

function getRestoreErrors(value: unknown, path = "workspace"): string[] {
	if (typeof value !== "object" || value == null) return [];
	if (!("getSnapshot" in value) || typeof value.getSnapshot !== "function")
		return [];
	const snapshot: unknown = value.getSnapshot();
	if (typeof snapshot !== "object" || snapshot == null) return [];
	if ("status" in snapshot && snapshot.status === "error")
		return [
			`${path}: ${"error" in snapshot ? String(snapshot.error) : "restore error"}`,
		];
	if (
		!("children" in snapshot) ||
		typeof snapshot.children !== "object" ||
		snapshot.children == null
	)
		return [];
	return Object.entries(snapshot.children).flatMap(([id, child]) =>
		getRestoreErrors(child, `${path}/${id}`),
	);
}

function getSnapshot(raw: string): Snapshot<unknown> {
	const value: unknown = JSON.parse(raw);
	if (
		typeof value !== "object" ||
		value == null ||
		!("status" in value) ||
		(value.status !== "active" &&
			value.status !== "done" &&
			value.status !== "error" &&
			value.status !== "stopped")
	)
		throw new Error("invalid checkpoint snapshot");
	// XState restores its own serialized tree; its complete snapshot type is not expressible as an Effect schema.
	return value as Snapshot<unknown>;
}

function getEvent(
	command: Command,
	key: string,
	resolveSettings: (
		command: Extract<Command, { type: "unit.add" }>,
	) => ReturnType<typeof getUnitSettings>,
) {
	switch (command.type) {
		case "unit.add": {
			return {
				type: "unit.add" as const,
				machine: command.machine,
				id: command.id ?? key,
				title: command.brief,
				repo: command.repo,
				deps: command.dependencies,
				...resolveSettings(command),
			};
		}
		case "task.answer":
			return command;
		case "hold.add":
			return {
				type: "hold.add" as const,
				hold: { id: key, mode: command.mode, scope: command.scope },
			};
		case "hold.lift":
			return command;
	}
}

function archiveRejected(path: string, destination: string) {
	try {
		linkSync(path, destination);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
			throw error;
	}
	unlinkSync(path);
}

/** Refuse a checkpoint for a different root or an unmigratable version. */
export function verifyCheckpoint(
	stored: Checkpoint,
	machine: {
		id: string;
		version: string | undefined;
		config: { migrate?: unknown };
	},
): void {
	if (
		stored.machine !== machine.id ||
		(stored.version !== machine.version &&
			typeof machine.config.migrate !== "function")
	)
		throw new Error(
			`checkpoint ${stored.machine}@${stored.version} cannot restore into ${machine.id}@${machine.version}`,
		);
}

/** Start the actor tree and expose the serialized inbox drain. */
export const openEngine = (options: Options) =>
	Effect.gen(function* () {
		mkdirSync(options.inbox, { recursive: true });
		const rejected = join(options.inbox, "rejected");
		mkdirSync(rejected, { recursive: true });
		const clock = yield* Clock.Clock;
		const stored = options.store.getCheckpoint();
		if (stored) verifyCheckpoint(stored, workspace);
		const actor = yield* createEffectActor(
			workspace,
			stored ? { snapshot: getSnapshot(stored.snapshot) } : {},
		);
		const errors = getRestoreErrors(actor);
		if (errors.length)
			throw new Error(`cannot restore machines: ${errors.join(", ")}`);
		const version = workspace.version;
		if (!version) throw new Error("workspace has no version");
		let pending: LogEntry[] = [];
		let busy = false;
		let draining = false;
		let active = true;
		let scheduled: NodeJS.Immediate | undefined;
		let revision = 0;
		let failure: unknown;
		const checkpoint = (): Checkpoint => {
			const errors = getRestoreErrors(actor);
			if (errors.length || actor.getSnapshot().status !== "active")
				throw new Error(
					`cannot capture failed actor tree: ${errors.join(", ")}`,
				);
			return {
				machine: workspace.id,
				version,
				snapshot: JSON.stringify(actor.getPersistedSnapshot()),
				at: clock.currentTimeMillisUnsafe(),
			};
		};
		const flush = () => {
			if (!active || busy || pending.length === 0) return;
			try {
				const entries = pending;
				options.store.commit(checkpoint(), entries);
				pending = [];
			} catch (error) {
				failure = error;
			}
		};
		actor.inspect((inspection) => {
			if (inspection.type !== "@xstate.transition") return;
			let event: unknown = inspection.event;
			if (
				inspection.event.type === "runner.started" &&
				"context" in inspection.snapshot
			) {
				try {
					const context = decodeStartedContext(inspection.snapshot.context);
					if (context.worker)
						event = {
							...inspection.event,
							taskId: context.spec.taskId,
							phase: context.spec.phase,
							tier: context.spec.tier,
							worker: context.worker,
							effort: context.spec.effort,
							timeLimitMs: context.spec.timeLimitMs,
						};
				} catch {
					/* Other actor snapshots do not carry task context. */
				}
			}
			pending.push({
				at: clock.currentTimeMillisUnsafe(),
				kind: "transition",
				key: "",
				address:
					"address" in inspection.actorRef &&
					typeof inspection.actorRef.address === "string"
						? inspection.actorRef.address
						: (inspection.actorRef.sessionId ?? "unknown"),
				event: JSON.stringify(event),
			});
			revision++;
			if (scheduled) clearImmediate(scheduled);
			scheduled = setImmediate(() => {
				scheduled = undefined;
				flush();
			});
		});
		if (!stored) options.store.commit(checkpoint(), []);
		const settle = Effect.gen(function* () {
			for (;;) {
				const seen = revision;
				yield* Effect.promise(
					() => new Promise<void>((resolve) => setImmediate(resolve)),
				);
				if (seen === revision) return;
			}
		});
		const drain = Effect.gen(function* () {
			if (draining) throw new Error("inbox drain already running");
			draining = true;
			try {
				if (failure) throw failure;
				for (const name of readdirSync(options.inbox)
					.filter((item) => !item.startsWith(".") && item.endsWith(".json"))
					.sort()) {
					const key = name.slice(0, -5);
					const path = join(options.inbox, name);
					const target = join(rejected, name);
					const disposition = options.store.getDisposition(key);
					if (disposition) {
						if (disposition === "rejected") archiveRejected(path, target);
						else unlinkSync(path);
						continue;
					}
					const at = yield* Clock.currentTimeMillis;
					busy = true;
					let status: "accepted" | "rejected" = "accepted";
					let body = readFileSync(path, "utf8");
					let command: Command | undefined;
					try {
						command = decodeCommand(JSON.parse(body));
					} catch (error) {
						status = "rejected";
						body = JSON.stringify({ input: body, error: String(error) });
					}
					if (command?.type === "unit.add" && !isUnitMachine(command.machine)) {
						status = "rejected";
						body = JSON.stringify({
							input: body,
							error: `unknown machine ${command.machine}`,
						});
						command = undefined;
					}
					const event = command
						? getEvent(command, key, options.resolveSettings ?? getUnitSettings)
						: undefined;
					if (event) {
						const invalid = validateWorkspaceEvent(actor.getSnapshot(), event);
						if (invalid) {
							status = "rejected";
							body = JSON.stringify({ input: body, error: invalid });
						} else {
							body = JSON.stringify(event);
							const result = yield* Effect.result(sendAndAwait(actor, event));
							if (result._tag === "Failure") {
								if (!(result.failure instanceof EventRejectedError))
									throw result.failure;
								status = "rejected";
								body = JSON.stringify({
									input: body,
									error: String(result.failure),
								});
							}
							const errors = getRestoreErrors(actor);
							if (errors.length || actor.getSnapshot().status !== "active")
								throw new Error(
									`actor failed while processing ${key}: ${errors.join(", ")}`,
								);
						}
					}
					if (status === "accepted") options.captureHook?.("after-send");
					yield* settle;
					options.captureHook?.("before-checkpoint");
					const entries = [
						...pending,
						{
							at,
							kind:
								status === "accepted"
									? ("inbox" as const)
									: ("rejected" as const),
							key,
							address: workspace.id,
							event: body,
						},
					];
					options.store.commit(checkpoint(), entries, {
						key,
						at,
						disposition: status,
					});
					pending = [];
					busy = false;
					if (status === "rejected") archiveRejected(path, target);
					else unlinkSync(path);
				}
				flush();
				if (failure) throw failure;
			} finally {
				draining = false;
			}
		});
		const close = () => {
			if (!active) return;
			if (scheduled) clearImmediate(scheduled);
			flush();
			active = false;
			if (failure) throw failure;
		};
		yield* Effect.addFinalizer(() => Effect.sync(close));
		return { actor, drain, close };
	});

export { Workers };
