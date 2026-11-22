import { createEffectActor, sendAndAwait, waitFor } from "@xstate/effect";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { createMachine } from "xstate";

const child = createMachine({
	initial: "working",
	states: {
		working: { on: { WORK: { target: "done" } } },
		done: { type: "final" },
	},
});
const parent = createMachine({
	actors: { child },
	initial: "working",
	on: { PING: () => {} },
	states: {
		working: {
			invoke: { id: "child", src: "child", onDone: { target: "success" } },
			on: { GO: (_, enq) => enq.sendTo("child", { type: "WORK" }) },
		},
		success: {},
	},
});

test.fails("#5892: a checkpoint retains a pending child completion", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(parent);
			yield* sendAndAwait(actor, { type: "GO" });
			const snapshot: ReturnType<typeof actor.getPersistedSnapshot> =
				JSON.parse(JSON.stringify(actor.getPersistedSnapshot()));
			yield* waitFor(actor, (state) => state.matches("success"), {
				timeout: "1 second",
			});
			const restored = yield* createEffectActor(parent, { snapshot });
			const state = yield* sendAndAwait(restored, { type: "PING" });
			expect(state.value).toBe("success");
		}).pipe(Effect.scoped),
	);
});

test("a settled child completion survives a checkpoint", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(parent);
			yield* sendAndAwait(actor, { type: "GO" });
			yield* waitFor(actor, (state) => state.matches("success"), {
				timeout: "1 second",
			});
			const snapshot: ReturnType<typeof actor.getPersistedSnapshot> =
				JSON.parse(JSON.stringify(actor.getPersistedSnapshot()));
			const restored = yield* createEffectActor(parent, { snapshot });
			const state = yield* sendAndAwait(restored, { type: "PING" });
			expect(state.value).toBe("success");
		}).pipe(Effect.scoped),
	);
});

test("#5892 fixture captures a finished child before the parent handles it", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(parent);
			yield* sendAndAwait(actor, { type: "GO" });
			const snapshot = actor.getPersistedSnapshot();
			expect(snapshot.value).toBe("working");
			expect(snapshot.children.child?.snapshot).toMatchObject({
				status: "done",
			});
			yield* waitFor(actor, (state) => state.matches("success"), {
				timeout: "1 second",
			});
		}).pipe(Effect.scoped),
	);
});
