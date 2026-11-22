import { createEffectActor, sendAndAwait } from "@xstate/effect";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { createMachine, types } from "xstate";
import { verifyCheckpoint } from "../src/engine.ts";

const makeCounter = (
	version: string,
	migrate?: (snapshot: unknown, from: string | undefined) => unknown,
) =>
	createMachine({
		id: "counter",
		version,
		migrate,
		schemas: {
			context: types<{ count: number }>(),
			events: { increment: types<Record<string, never>>() },
		},
		context: { count: 0 },
		initial: "ready",
		states: {
			ready: {
				on: {
					increment: ({ context }) => ({
						context: { count: context.count + 1 },
					}),
				},
			},
		},
	});

test("root migration restores an old checkpoint and continues", async () => {
	const old = makeCounter("1");
	const next = makeCounter("2", (snapshot, from) => {
		expect(from).toBe("1");
		if (
			typeof snapshot !== "object" ||
			snapshot == null ||
			!("context" in snapshot) ||
			typeof snapshot.context !== "object" ||
			snapshot.context == null ||
			!("count" in snapshot.context) ||
			typeof snapshot.context.count !== "number"
		)
			throw new Error("invalid snapshot");
		return { ...snapshot, context: { count: snapshot.context.count + 100 } };
	});
	const saved = await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(old);
			yield* sendAndAwait(actor, { type: "increment" });
			return actor.getPersistedSnapshot();
		}).pipe(Effect.scoped),
	);
	const checkpoint = {
		machine: "counter",
		version: "1",
		snapshot: JSON.stringify(saved),
		at: 0,
	};
	expect(() => verifyCheckpoint(checkpoint, makeCounter("2"))).toThrow(
		"checkpoint counter@1",
	);
	expect(() => verifyCheckpoint(checkpoint, next)).not.toThrow();
	await expect(
		Effect.runPromise(
			Effect.gen(function* () {
				yield* createEffectActor(makeCounter("2"), { snapshot: saved });
			}).pipe(Effect.scoped),
		),
	).rejects.toThrow();
	const count = await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(next, { snapshot: saved });
			yield* sendAndAwait(actor, { type: "increment" });
			return actor.getSnapshot().context.count;
		}).pipe(Effect.scoped),
	);
	expect(count).toBe(102);
});
