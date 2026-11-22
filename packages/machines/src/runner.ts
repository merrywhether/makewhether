import {
	type HoldScope,
	TaskSpec,
	Worker,
	type WorkerReport,
} from "@makewhether/domain";
import { createEffectEventStreamLogic } from "@xstate/effect";
import { Context, Effect, Queue, Schema, type Scope, Stream } from "effect";

export const RunnerInput = Schema.Struct({
	key: Schema.String,
	run: Schema.Number,
	spec: TaskSpec,
	worker: Worker,
	resume: Schema.UndefinedOr(Schema.String),
});
export type RunnerInput = typeof RunnerInput.Type;

export type RunnerEvent =
	| { type: "runner.started"; sessionId: string }
	| { type: "runner.report"; outcome: WorkerReport }
	| { type: "runner.failed"; reason: "crashed" | "lost"; detail: string }
	| {
			type: "runner.limit";
			holdId: string;
			scope: typeof HoldScope.Type;
			resetsAt: number;
			at: number;
	  };

export class Workers extends Context.Service<
	Workers,
	{
		readonly run: (
			input: RunnerInput,
			emit: (event: RunnerEvent) => void,
		) => Effect.Effect<void, never, Scope.Scope>;
	}
>()("makew/Workers") {}

export const runner = createEffectEventStreamLogic({
	schemas: { input: RunnerInput },
	stream: ({ input }) =>
		Stream.callback<RunnerEvent, never, Workers>((queue) =>
			Effect.gen(function* () {
				const workers = yield* Workers;
				yield* workers.run(input, (event) => Queue.offerUnsafe(queue, event));
				Queue.endUnsafe(queue);
			}),
		),
});
