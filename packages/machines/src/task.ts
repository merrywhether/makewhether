import {
	Hold,
	HoldScope,
	matchesHold,
	Outcome,
	TaskSpec,
	Worker,
	WorkerReport,
} from "@makewhether/domain";
import { setupEffect } from "@xstate/effect";
import { Effect, Schema } from "effect";
import { runner } from "./runner.ts";

export const HoldRequest = Schema.Struct({
	holdId: Schema.String,
	scope: HoldScope,
	resetsAt: Schema.Number,
	at: Schema.Number,
});

const TaskInput = Schema.Struct({ spec: TaskSpec, holds: Schema.Array(Hold) });
const decodeTaskInput = Schema.decodeUnknownSync(TaskInput);

const RunningInput = Schema.Struct({ run: Schema.Number, worker: Worker });

const TaskContext = Schema.Struct({
	spec: TaskSpec,
	holds: Schema.Array(Hold),
	run: Schema.Number,
	failures: Schema.Number,
	sessionId: Schema.UndefinedOr(Schema.String),
	worker: Schema.UndefinedOr(Worker),
	outcome: Schema.UndefinedOr(Outcome),
});

type TaskContext = typeof TaskContext.Type;

function retry(context: TaskContext, detail: string) {
	const failures = context.failures + 1;
	const updated = { ...context, failures };
	return failures >= context.spec.attemptLimit
		? {
				target: "done" as const,
				context: {
					...updated,
					outcome: { kind: "exhausted" as const, detail },
				},
			}
		: { target: "start" as const, context: updated };
}

export const task = setupEffect({
	schemas: {
		input: TaskInput,
		context: TaskContext,
		events: {
			"runner.started": Schema.Struct({ sessionId: Schema.String }),
			"runner.parked": Schema.Struct({}),
			"runner.report": Schema.Struct({ outcome: WorkerReport }),
			"runner.failed": Schema.Struct({
				reason: Schema.Literals(["crashed", "lost"]),
				detail: Schema.String,
			}),
			"runner.limit": HoldRequest,
			"hold.placed": Schema.Struct({ hold: Hold }),
			"hold.lifted": Schema.Struct({ holdId: Schema.String }),
			answer: Schema.Struct({ taskId: Schema.String, outcome: Outcome }),
		},
		output: Schema.Struct({ outcome: Outcome, worker: Worker }),
		actions: { remind: { params: Schema.Struct({ taskId: Schema.String }) } },
	},
	states: {
		running: { schemas: { input: RunningInput } },
		asking: { schemas: { input: Worker } },
	},
	actors: { runner },
	actions: { remind: ({ taskId }) => Effect.log(`still waiting: ${taskId}`) },
}).createMachine({
	id: "task",
	version: "1",
	context: ({ input }) => ({
		...decodeTaskInput(input),
		run: 0,
		failures: 0,
		sessionId: undefined,
		worker: undefined,
		outcome: undefined,
	}),
	initial: "start",
	on: {
		"hold.placed": ({ context, event }) => ({
			context: {
				...context,
				holds: [
					...context.holds.filter((hold) => hold.id !== event.hold.id),
					event.hold,
				],
			},
		}),
		"hold.lifted": ({ context, event }) => ({
			context: {
				...context,
				holds: context.holds.filter((hold) => hold.id !== event.holdId),
			},
		}),
	},
	states: {
		start: {
			type: "choice",
			choice: ({ context }) => {
				const candidates = context.worker
					? [context.worker]
					: context.spec.workers;
				const worker = candidates.find(
					(candidate) =>
						!context.holds.some((hold) =>
							matchesHold(hold.scope, candidate, context.spec.repo),
						),
				);
				if (!worker) return { target: "held" };
				if (worker.harness === "person")
					return { target: "asking", input: worker };
				return { target: "running", input: { run: context.run + 1, worker } };
			},
		},
		running: {
			entry: ({ context, input }) => ({
				context: { ...context, run: input.run, worker: input.worker },
			}),
			invoke: {
				id: "runner",
				src: "runner",
				input: ({ context, input }) => ({
					key: `${context.spec.taskId}#${input.run}`,
					run: input.run,
					spec: context.spec,
					worker: input.worker,
					resume: context.sessionId,
				}),
				onError: ({ context }) => retry(context, "runner error"),
				onDone: ({ context }) =>
					retry(context, "runner ended without an outcome"),
			},
			on: {
				"runner.started": ({ context, event }) => ({
					context: {
						...context,
						sessionId: event.sessionId,
					},
				}),
				"runner.report": ({ context, event }) => ({
					target: "done",
					context: { ...context, outcome: event.outcome },
				}),
				"runner.failed": ({ context, event }) => retry(context, event.detail),
				"runner.parked": () => ({ target: "start" }),
				"runner.limit": ({ context, event, parent }, enq) => {
					const { type: _, ...request } = event;
					enq.sendTo(parent, { type: "hold.request", ...request });
					const hold = {
						id: event.holdId,
						scope: event.scope,
						mode: "hard" as const,
					};
					return {
						target: "held",
						context: {
							...context,
							holds: [
								...context.holds.filter((item) => item.id !== hold.id),
								hold,
							],
						},
					};
				},
				"hold.placed": ({ context, event, input }) => {
					const holds = [
						...context.holds.filter((hold) => hold.id !== event.hold.id),
						event.hold,
					];
					if (
						event.hold.mode === "hard" &&
						matchesHold(event.hold.scope, input.worker, context.spec.repo)
					)
						return {
							target: "held",
							context: {
								...context,
								holds,
							},
						};
					return { context: { ...context, holds } };
				},
			},
		},
		held: {
			on: {
				"hold.lifted": ({ context, event }) => ({
					target: "start",
					context: {
						...context,
						holds: context.holds.filter((hold) => hold.id !== event.holdId),
					},
				}),
			},
		},
		asking: {
			entry: ({ context, input }) => ({
				context: { ...context, worker: input },
			}),
			after: {
				PT2H: ({ context, actions, self, input }, enq) => {
					enq(actions.remind, { taskId: context.spec.taskId, self });
					return { target: "asking", reenter: true, input };
				},
			},
			on: {
				answer: ({ context, event }) =>
					event.taskId === context.spec.taskId
						? {
								target: "done",
								context: { ...context, outcome: event.outcome },
							}
						: undefined,
			},
		},
		done: {
			type: "final",
			output: ({ context }) => {
				if (!context.outcome || !context.worker)
					throw new Error("finished task has no outcome or worker");
				return { outcome: context.outcome, worker: context.worker };
			},
		},
	},
});
