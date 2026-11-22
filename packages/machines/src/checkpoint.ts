import {
	hasPersonFinalTier,
	Phase,
	type StuckReason,
	StuckUnit,
	UnitId,
} from "@makewhether/domain";
import { Schema } from "effect";
import type { Snapshot } from "xstate";
import { smallUnit } from "./small-unit.ts";
import { unit } from "./unit.ts";
import { getTaskId, parkUnit, phaseState, UnitContext } from "./unit-logic.ts";
import { getUnitActorId, parseUnitActorId } from "./workspace.ts";

const decodeContext = Schema.decodeUnknownSync(UnitContext);
const decodePhaseInput = Schema.decodeUnknownOption(phaseState.schemas.input);
const decodeStuck = Schema.decodeUnknownSync(StuckUnit);
const isPhase = Schema.is(Phase);
const isUnitId = Schema.is(UnitId);
const decodeRegistration = Schema.decodeUnknownSync(
	Schema.Array(
		Schema.Struct({ id: Schema.String, deps: Schema.Array(Schema.String) }),
	),
);

function record(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value == null || Array.isArray(value))
		return undefined;
	return Object.fromEntries(Object.entries(value));
}

function checkpointUnits(snapshot: unknown) {
	const root = record(snapshot);
	const children = record(root?.children);
	const context = record(root?.context);
	const registrations = decodeRegistration(context?.units);
	const registered = new Set(registrations.map(({ id }) => getUnitActorId(id)));
	for (const key of Object.keys(children ?? {}))
		if (!registered.has(key))
			throw new Error(
				`cannot restore workspace/${key}: missing unit registration`,
			);
	const finished = record(context?.finished);
	return registrations.flatMap(({ id, deps }) => {
		const key = getUnitActorId(id);
		const child = record(children?.[key]);
		const saved = record(child?.snapshot);
		if (
			!child &&
			(finished?.[id] === "passed" || finished?.[id] === "cancelled")
		)
			return [];
		if (!child || !saved)
			throw new Error(`cannot restore unit ${id}: missing unit snapshot`);
		return [
			{
				id,
				deps,
				key,
				child,
				saved,
				depsPassed: deps.filter((dep) => finished?.[dep] === "passed"),
				depsCancelled: deps.filter((dep) => finished?.[dep] === "cancelled"),
			},
		];
	});
}

type SavedUnit = ReturnType<typeof checkpointUnits>[number];

function parkReason(
	entry: SavedUnit,
	context: UnitContext,
): StuckReason | undefined {
	const { id, deps, saved, child } = entry;
	const mismatchedRegistration =
		context.id !== id ||
		context.deps.length !== deps.length ||
		deps.some((dep, i) => dep !== context.deps[i]);
	const invalidIdentity = !isUnitId(id) || deps.some((dep) => !isUnitId(dep));
	if (
		mismatchedRegistration ||
		(invalidIdentity && context.stuck?.reason !== "invalid-unit-identity")
	)
		return "invalid-unit-identity";

	if (saved.value === "stuck") {
		const children = record(saved.children);
		return context.stuck &&
			context.stuck.episode === context.stuckEpisode &&
			children &&
			Object.keys(children).length === 0 &&
			Array.isArray(saved.timers) &&
			saved.timers.length === 0
			? undefined
			: "invalid-task-state";
	}

	if (!hasPersonFinalTier(context.routes)) return "invalid-final-tier";
	if (saved.value === "queued") return undefined;
	const phase = saved.value;
	const machine = child.src === "smallUnit" ? smallUnit : unit;
	if (!isPhase(phase) || (phase === "judge" && machine === smallUnit))
		return "invalid-task-state";

	const input = decodePhaseInput(
		record(saved.stateInputs)?.[`${machine.id}.${phase}`],
	);
	const step =
		input._tag === "Some" ? context.routes[phase][input.value.tier] : undefined;
	const task = record(record(record(saved.children)?.task)?.snapshot);
	const taskContext = record(task?.context);
	const spec = record(taskContext?.spec);
	if (
		!step ||
		input._tag !== "Some" ||
		input.value.taskId !== getTaskId(id, context.seq, phase, step.tier) ||
		spec?.taskId !== input.value.taskId ||
		spec.phase !== phase
	)
		return "invalid-task-state";

	if (
		phase === "intervene" &&
		input.value.tier === context.routes.intervene.length - 1
	) {
		const assigned = record(taskContext?.worker);
		const candidates = spec.workers;
		if (
			task?.value === "running" ||
			(assigned && assigned.harness !== "person") ||
			!Array.isArray(candidates) ||
			candidates.length === 0 ||
			candidates.some((candidate) => record(candidate)?.harness !== "person")
		)
			return "non-person-final-worker";
	}
	return undefined;
}

/** Park recoverable unit snapshots before XState can start their saved task actors. */
export function prepareWorkspaceCheckpoint(snapshot: Snapshot<unknown>) {
	const children: Record<string, unknown> = {};
	const parked: { unitId: string; stuck: typeof StuckUnit.Type }[] = [];
	for (const entry of checkpointUnits(snapshot)) {
		const machine = entry.child.src === "smallUnit" ? smallUnit : unit;
		const identity = record(entry.saved.machine);
		const version = identity?.version ?? entry.saved.version;
		if (
			(entry.child.src !== "unit" && entry.child.src !== "smallUnit") ||
			(identity?.id !== undefined && identity.id !== machine.id) ||
			version !== machine.version ||
			(entry.saved.version !== undefined && entry.saved.version !== version)
		)
			throw new Error(
				`cannot restore workspace/${entry.key}: incompatible unit checkpoint`,
			);
		let context: UnitContext;
		try {
			context = decodeContext(entry.saved.context);
		} catch (error) {
			throw new Error(`cannot restore unit ${entry.id}: invalid unit context`, {
				cause: error,
			});
		}
		if (entry.saved.status !== "active") continue;
		const reason = parkReason(entry, context);
		if (!reason) continue;
		const next = parkUnit(
			{
				...context,
				id: entry.id,
				deps: entry.deps,
				depsPassed: entry.depsPassed,
				depsCancelled: entry.depsCancelled,
			},
			reason,
		);
		parked.push({ unitId: entry.id, stuck: next.context.stuck });
		const stuck = { value: next.target, context: next.context };
		const replacement =
			machine === smallUnit
				? smallUnit.getPersistedSnapshot(smallUnit.resolveState(stuck))
				: unit.getPersistedSnapshot(unit.resolveState(stuck));
		children[entry.key] = { ...entry.child, snapshot: replacement };
	}
	return {
		parked,
		snapshot: parked.length
			? {
					...snapshot,
					children: { ...record(record(snapshot)?.children), ...children },
				}
			: snapshot,
	};
}

export function readCheckpointStuckUnits(snapshot: unknown) {
	const children = record(record(snapshot)?.children);
	return Object.entries(children ?? {}).flatMap(([id, child]) => {
		const unitId = parseUnitActorId(id);
		const saved = record(record(child)?.snapshot);
		return unitId !== undefined &&
			saved?.value === "stuck" &&
			saved.status === "active"
			? [
					{
						unitId,
						stuck: decodeStuck(record(saved.context)?.stuck),
					},
				]
			: [];
	});
}
