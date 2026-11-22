import {
	Hold,
	hasPersonFinalTier,
	MachineStateMeta,
	Outcome,
	UnitDecisionEvent,
} from "@makewhether/domain";
import { setupEffect } from "@xstate/effect";
import { Schema } from "effect";
import { HoldRequest, task } from "./task.ts";
import {
	decide,
	decodeUnitInput,
	enter,
	parkUnit,
	phaseState,
	recoverStuck,
	rework,
	route,
	stuckDecisionProblem,
	taskInput,
	UnitContext,
	UnitInput,
	unitDependencyTransitions,
} from "./unit-logic.ts";

function enterSmall(...args: Parameters<typeof enter>) {
	const next = enter(...args);
	if (next.target === "judge") throw new Error("small unit has no judge phase");
	return next;
}
function recoverSmall(...args: Parameters<typeof recoverStuck>) {
	const next = recoverStuck(...args);
	if (next.target === "judge") throw new Error("small unit has no judge phase");
	return next;
}
function smallRoute(...args: Parameters<typeof route>) {
	const next = route(args[0], args[1], args[2], args[3], args[4], false);
	if (next.target === "judge") throw new Error("small unit has no judge phase");
	return next;
}

export const smallUnit = setupEffect({
	schemas: {
		meta: MachineStateMeta,
		input: UnitInput,
		context: UnitContext,
		events: {
			"dep.passed": Schema.Struct({ unit: Schema.String }),
			"dep.cancelled": Schema.Struct({ unit: Schema.String }),
			"hold.placed": Schema.Struct({ hold: Hold }),
			"hold.lifted": Schema.Struct({ holdId: Schema.String }),
			"hold.request": HoldRequest,
			"unit.decide": UnitDecisionEvent,
			answer: Schema.Struct({ taskId: Schema.String, outcome: Outcome }),
		},
		output: Schema.Struct({
			unit: Schema.String,
			verdict: Schema.Literals(["passed", "cancelled"]),
			reason: Schema.UndefinedOr(Schema.String),
		}),
	},
	states: {
		implement: phaseState,
		verify: phaseState,
		intervene: phaseState,
	},
	actors: { task },
}).createMachine({
	id: "small-unit",
	version: "1",
	context: ({ input }) => ({
		...decodeUnitInput(input),
		seq: 0,
		round: 1,
		notes: [],
		from: "implement",
		interventions: 0,
		cancelledDependency: undefined,
	}),
	initial: "queued",
	on: {
		"hold.placed": ({ context, event, children }, enq) => {
			if (children.task) enq.sendTo(children.task, event);
			return {
				context: {
					...context,
					holds: [
						...context.holds.filter((hold) => hold.id !== event.hold.id),
						event.hold,
					],
				},
			};
		},
		"hold.lifted": ({ context, event, children }, enq) => {
			if (children.task) enq.sendTo(children.task, event);
			return {
				context: {
					...context,
					holds: context.holds.filter((hold) => hold.id !== event.holdId),
				},
			};
		},
		"hold.request": ({ event, parent }, enq) => {
			enq.sendTo(parent, event);
		},
		answer: ({ event, children }, enq) => {
			if (children.task) enq.sendTo(children.task, event);
		},
	},
	states: {
		queued: {
			meta: { waitsOn: "dependency" },
			always: ({ context }) => {
				const cancelled = context.depsCancelled[0];
				if (cancelled !== undefined)
					return {
						target: "cancelled",
						context: { ...context, cancelledDependency: cancelled },
					};
				return context.deps.every((dep) => context.depsPassed.includes(dep))
					? enterSmall(context, "implement")
					: undefined;
			},
			on: unitDependencyTransitions,
		},
		implement: {
			meta: {
				waitsOn: "task",
				role: "implement",
				phase: "implement",
				handles: ["done", "up"],
			},
			invoke: {
				id: "task",
				src: "task",
				input: ({ context, input }) => taskInput(context, "implement", input),
				onDone: ({ context, event, input }) =>
					smallRoute(context, "implement", input, event.output, {
						done: (c) => enter(c, "verify"),
					}),
			},
		},
		verify: {
			meta: {
				waitsOn: "task",
				role: "verify",
				phase: "verify",
				handles: ["pass", "fail", "up"],
			},
			invoke: {
				id: "task",
				src: "task",
				input: ({ context, input }) => taskInput(context, "verify", input),
				onDone: ({ context, event, input }) =>
					smallRoute(context, "verify", input, event.output, {
						pass: () => ({ target: "passed" }),
						fail: (c, o) => rework(c, "verify", o),
					}),
			},
		},

		intervene: {
			always: ({ context, input }) =>
				input &&
				input.tier === context.routes.intervene.length - 1 &&
				!hasPersonFinalTier(context.routes)
					? parkUnit(context, "invalid-final-tier")
					: undefined,
			meta: {
				waitsOn: "task",
				role: "intervene",
				phase: "intervene",
				handles: ["decision", "up"],
			},
			invoke: {
				id: "task",
				src: "task",
				input: ({ context, input }) => taskInput(context, "intervene", input),
				onDone: ({ context, event, input }) =>
					smallRoute(context, "intervene", input, event.output, {
						decision: decide,
					}),
			},
		},
		stuck: {
			meta: { waitsOn: "person" },
			on: {
				...unitDependencyTransitions,
				"unit.decide": ({ context, event }) =>
					stuckDecisionProblem(context, event, false) === undefined
						? recoverSmall(context, event)
						: undefined,
			},
		},
		passed: {
			type: "final",
			entry: ({ context, parent }, enq) =>
				enq.sendTo(parent, {
					type: "unit.finished",
					unit: context.id,
					verdict: "passed",
					reason: undefined,
				}),
			output: ({ context }) => ({
				unit: context.id,
				verdict: "passed",
				reason: undefined,
			}),
		},
		cancelled: {
			type: "final",
			entry: ({ context, parent }, enq) =>
				enq.sendTo(parent, {
					type: "unit.finished",
					unit: context.id,
					verdict: "cancelled",
					reason: context.cancelledDependency,
				}),
			output: ({ context }) => ({
				unit: context.id,
				verdict: "cancelled",
				reason: context.cancelledDependency,
			}),
		},
	},
});

export default smallUnit;
