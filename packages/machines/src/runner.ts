import { type RunnerEvent, RunnerInput } from "@makewhether/domain";
import { createEffectEventStreamLogic } from "@xstate/effect";
import { Context, Effect, Queue, type Scope, Stream } from "effect";

export type { RunnerEvent, RunnerInput } from "@makewhether/domain";

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
