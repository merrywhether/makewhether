import {
	Hold,
	HoldAddEvent,
	HoldLiftEvent,
	matchesHold,
	TaskAnswerEvent,
	UnitAddEvent,
	type Worker,
} from "@makewhether/domain";
import { setupEffect } from "@xstate/effect";
import { Schema } from "effect";
import type { EventFrom, SnapshotFrom } from "xstate";
import { smallUnit } from "./small-unit.ts";
import { HoldRequest } from "./task.ts";
import { unit } from "./unit.ts";

export const unitMachineNames = ["unit", "small-unit"] as const;

const UnitRef = Schema.Struct({
	id: Schema.String,
	deps: Schema.Array(Schema.String),
});
const Result = Schema.Literals(["passed", "cancelled"]);

export const workspace = setupEffect({
	schemas: {
		context: Schema.Struct({
			units: Schema.Array(UnitRef),
			finished: Schema.Record(Schema.String, Result),
			cancellationReasons: Schema.Record(Schema.String, Schema.String),
			holds: Schema.Array(Hold),
		}),
		events: {
			"unit.add": UnitAddEvent,
			"unit.finished": Schema.Struct({
				unit: Schema.String,
				verdict: Result,
				reason: Schema.UndefinedOr(Schema.String),
			}),
			"hold.request": HoldRequest,
			"hold.add": HoldAddEvent,
			"hold.lift": HoldLiftEvent,
			"task.answer": TaskAnswerEvent,
		},
		internalEvents: { "hold.expire": Schema.Struct({ holdId: Schema.String }) },
	},
	actors: { unit, smallUnit },
}).createMachine({
	id: "workspace",
	version: "1",
	context: { units: [], finished: {}, cancellationReasons: {}, holds: [] },
	on: {
		"unit.add": ({ context, event }, enq) => {
			if (context.units.some((item) => item.id === event.id)) return undefined;
			const { type: _, ...input } = event;
			const childInput = {
				...input,
				holds: context.holds,
				depsCancelled: event.deps.filter(
					(dep) => context.finished[dep] === "cancelled",
				),
				depsPassed: event.deps.filter(
					(dep) => context.finished[dep] === "passed",
				),
			};
			const child = { id: getUnitActorId(event.id), input: childInput };
			if ("machine" in event && event.machine === "small-unit")
				enq.spawn("smallUnit", child);
			else enq.spawn("unit", child);
			return {
				context: {
					...context,
					units: [...context.units, { id: event.id, deps: event.deps }],
				},
			};
		},
		"unit.finished": ({ context, event }, enq) => {
			if (isFinished(context.finished[event.unit])) return undefined;
			for (const item of context.units) {
				if (
					item.deps.includes(event.unit) &&
					!isFinished(context.finished[item.id])
				) {
					enq.sendTo(getUnitActorId(item.id), {
						type: event.verdict === "passed" ? "dep.passed" : "dep.cancelled",
						unit: event.unit,
					});
				}
			}
			return {
				context: {
					...context,
					finished: { ...context.finished, [event.unit]: event.verdict },
					cancellationReasons:
						event.reason === undefined
							? context.cancellationReasons
							: { ...context.cancellationReasons, [event.unit]: event.reason },
				},
			};
		},
		"hold.request": ({ context, event }, enq) => {
			if (context.holds.some((hold) => hold.id === event.holdId))
				return undefined;
			const hold = {
				id: event.holdId,
				scope: event.scope,
				mode: "hard" as const,
			};
			enq.raise(
				{ type: "hold.expire", holdId: hold.id },
				{ delay: Math.max(0, event.resetsAt - event.at), id: hold.id },
			);
			for (const id of getActive(context))
				enq.sendTo(getUnitActorId(id), { type: "hold.placed", hold });
			return { context: { ...context, holds: [...context.holds, hold] } };
		},
		"hold.add": ({ context, event }, enq) => {
			if (context.holds.some((hold) => hold.id === event.hold.id))
				return undefined;
			for (const id of getActive(context))
				enq.sendTo(getUnitActorId(id), {
					type: "hold.placed",
					hold: event.hold,
				});
			return { context: { ...context, holds: [...context.holds, event.hold] } };
		},
		"hold.lift": ({ context, event }, enq) => {
			enq.cancel(event.holdId);
			for (const id of getActive(context))
				enq.sendTo(getUnitActorId(id), {
					type: "hold.lifted",
					holdId: event.holdId,
				});
			return {
				context: {
					...context,
					holds: context.holds.filter((hold) => hold.id !== event.holdId),
				},
			};
		},
		"hold.expire": ({ context, event }, enq) => {
			for (const id of getActive(context))
				enq.sendTo(getUnitActorId(id), {
					type: "hold.lifted",
					holdId: event.holdId,
				});
			return {
				context: {
					...context,
					holds: context.holds.filter((hold) => hold.id !== event.holdId),
				},
			};
		},
		"task.answer": ({ context, event }, enq) => {
			for (const id of getActive(context))
				enq.sendTo(getUnitActorId(id), {
					type: "answer",
					taskId: event.taskId,
					outcome: event.outcome,
				});
		},
	},
});

function getActive(context: {
	units: readonly { id: string }[];
	finished: Readonly<Record<string, string>>;
}) {
	return context.units
		.map((item) => item.id)
		.filter((id) => !isFinished(context.finished[id]));
}

function getUnitActorId(id: string) {
	return `unit:${id}`;
}

function isFinished(verdict: string | undefined) {
	return verdict === "passed" || verdict === "cancelled";
}

/** Validate inbox events against the current workspace state. */
export function validateWorkspaceEvent(
	snapshot: SnapshotFrom<typeof workspace>,
	event: EventFrom<typeof workspace>,
): string | undefined {
	const context = snapshot.context;
	if (
		event.type === "unit.add" &&
		context.units.some((unit) => unit.id === event.id)
	)
		return `duplicate unit ${event.id}`;
	if (
		event.type === "hold.lift" &&
		!context.holds.some((hold) => hold.id === event.holdId)
	)
		return `unknown hold ${event.holdId}`;
	if (event.type === "task.answer") {
		const found = Object.values(snapshot.children).some((unit) => {
			const task = unit?.getSnapshot().children.task?.getSnapshot();
			return (
				task?.value === "asking" && task.context.spec.taskId === event.taskId
			);
		});
		if (!found) return `unknown waiting task ${event.taskId}`;
	}
	return undefined;
}

/** Project the current actor tree without storing derived cancellation information. */
export function readUnits(snapshot: SnapshotFrom<typeof workspace>) {
	const { units, finished, cancellationReasons } = snapshot.context;
	return units.map((entry) => {
		const verdict = finished[entry.id];
		const unit = snapshot.children[getUnitActorId(entry.id)]?.getSnapshot();
		const task = unit?.children.task?.getSnapshot();
		const dependencies = entry.deps.filter((id) => finished[id] !== "passed");
		const holds =
			task?.value === "held"
				? task.context.holds.filter((hold: typeof Hold.Type) =>
						(task.context.worker
							? [task.context.worker]
							: task.context.spec.workers
						).some((worker: typeof Worker.Type) =>
							matchesHold(hold.scope, worker, task.context.spec.repo),
						),
					)
				: [];
		const waiting =
			task && (task.value === "running" || task.value === "asking")
				? {
						id: task.context.spec.taskId,
						phase: task.context.spec.phase,
						state: task.value,
						worker: task.context.worker,
					}
				: undefined;
		let cancelCascade: string[] | undefined;
		if (
			task?.value === "asking" &&
			task.context.spec.phase === "intervene" &&
			task.context.worker?.harness === "person"
		) {
			const affected = new Set([entry.id]);
			let changed = true;
			while (changed) {
				changed = false;
				for (const other of units)
					if (
						!affected.has(other.id) &&
						!isFinished(finished[other.id]) &&
						other.deps.some((dep) => affected.has(dep))
					) {
						affected.add(other.id);
						changed = true;
					}
			}
			affected.delete(entry.id);
			cancelCascade = [...affected];
		}
		return {
			id: entry.id,
			verdict: isFinished(verdict) ? verdict : undefined,
			reason: cancellationReasons[entry.id],
			dependencies,
			task: waiting,
			holds,
			cancelCascade,
		};
	});
}
