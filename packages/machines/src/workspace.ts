import { Hold, Outcome, Routes, UnitId } from "@makewhether/domain";
import { setupEffect } from "@xstate/effect";
import { Schema } from "effect";
import { standardSchemaValidator } from "xstate/validation";
import { HoldRequest } from "./task.ts";
import { unit } from "./unit.ts";

const UnitRef = Schema.Struct({
	id: Schema.String,
	deps: Schema.Array(UnitId),
});
const Result = Schema.Literals(["passed", "cancelled"]);

const unitFields = {
	id: UnitId,
	repo: Schema.String,
	title: Schema.String,
	deps: Schema.Array(UnitId),
	routes: Routes,
	maxRounds: Schema.Number,
	interventionCap: Schema.Number,
};
const UnitAdd = Schema.Union([
	Schema.Struct({ ...unitFields, attemptLimit: Schema.Number }),
	Schema.Struct(unitFields),
]);

export const workspace = setupEffect({
	validator: standardSchemaValidator(),
	schemas: {
		context: Schema.Struct({
			units: Schema.Array(UnitRef),
			finished: Schema.Record(Schema.String, Result),
			cancellationReasons: Schema.Record(Schema.String, Schema.String),
			holds: Schema.Array(Hold),
		}),
		events: {
			"unit.add": UnitAdd,
			"unit.finished": Schema.Struct({
				unit: Schema.String,
				verdict: Result,
				reason: Schema.UndefinedOr(Schema.String),
			}),
			"hold.request": HoldRequest,
			"hold.add": Schema.Struct({ hold: Hold }),
			"hold.lift": Schema.Struct({ holdId: Schema.String }),
			"task.answer": Schema.Struct({ taskId: Schema.String, outcome: Outcome }),
		},
		internalEvents: { "hold.expire": Schema.Struct({ holdId: Schema.String }) },
	},
	actors: { unit },
}).createMachine({
	id: "workspace",
	version: "1",
	context: { units: [], finished: {}, cancellationReasons: {}, holds: [] },
	on: {
		"unit.add": ({ context, event }, enq) => {
			if (unitAddError(context.units, event)) return undefined;
			const { type: _, ...input } = event;
			enq.spawn("unit", {
				id: getUnitActorId(event.id),
				input: {
					...input,
					attemptLimit:
						("attemptLimit" in event ? event.attemptLimit : undefined) ?? 2,
					holds: context.holds,
					depsCancelled: event.deps.filter(
						(dep) => context.finished[dep] === "cancelled",
					),
					depsPassed: event.deps.filter(
						(dep) => context.finished[dep] === "passed",
					),
				},
			});
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

function unitAddError(
	units: readonly (typeof UnitRef.Type)[],
	unit: typeof UnitRef.Type,
): string | undefined {
	const dependencies = new Map(units.map(({ id, deps }) => [id, deps]));
	if (dependencies.has(unit.id)) return `duplicate unit ${unit.id}`;
	const pending = [...unit.deps];
	const visited = new Set<string>();
	for (const id of pending) {
		if (id === unit.id) return `dependency cycle for unit ${unit.id}`;
		if (visited.has(id)) continue;
		visited.add(id);
		for (const dependency of dependencies.get(id) ?? [])
			pending.push(dependency);
	}
	return undefined;
}
