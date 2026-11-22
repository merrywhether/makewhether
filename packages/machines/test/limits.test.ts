import type { TaskSpec } from "@makewhether/domain";
import {
	createEffectActor,
	EventRejectedError,
	sendAndAwait,
} from "@xstate/effect";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { initialTransition, transition } from "xstate";
import { Workers } from "../src/runner.ts";
import { task } from "../src/task.ts";
import { unit } from "../src/unit.ts";
import { workspace } from "../src/workspace.ts";

const person = {
	harness: "person",
	model: "person",
	account: "person",
} as const;
const tier = { tier: "person", workers: [person] as const, rules: {} };
const add = {
	type: "unit.add",
	id: "U",
	repo: "repo",
	title: "U",
	deps: ["P"],
	routes: {
		implement: [tier],
		verify: [tier],
		judge: [tier],
		intervene: [tier],
	},
	attemptLimit: 1,
	maxRounds: 1,
	interventionCap: 0,
} as const;
const spec: TaskSpec = {
	taskId: "U/1.implement.person",
	phase: "implement",
	repo: add.repo,
	title: add.title,
	tier: tier.tier,
	workers: tier.workers,
	notes: [],
	prior: undefined,
	attemptLimit: add.attemptLimit,
};
const numericOverflow: number = JSON.parse("1e309");
const invalidNumbers = [
	Infinity,
	NaN,
	"never",
	numericOverflow,
	0.5,
	-1,
	Number.MAX_SAFE_INTEGER + 1,
];
const invalidPositiveLimits = [...invalidNumbers, 0];
const invalidLimits = [
	["attemptLimit", invalidPositiveLimits],
	["maxRounds", invalidPositiveLimits],
	["interventionCap", invalidNumbers],
] as const;

test("workspace rejects invalid limits before spawning a unit", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(workspace);
			for (const [field, invalid] of invalidLimits) {
				for (const value of invalid) {
					const result = yield* Effect.result(
						sendAndAwait(actor, { ...add, [field]: value }),
					);
					expect(result, `${field}=${String(value)}`).toMatchObject({
						_tag: "Failure",
						failure: expect.any(EventRejectedError),
					});
				}
			}
			expect(actor.getSnapshot().context.units).toEqual([]);
			expect(actor.getSnapshot().children).toEqual({});
			yield* sendAndAwait(actor, add);
			expect(
				actor.getSnapshot().children["unit:U"]?.getSnapshot().context,
			).toMatchObject({ attemptLimit: 1, maxRounds: 1, interventionCap: 0 });
		}).pipe(
			Effect.scoped,
			Effect.provideService(Workers, {
				run: () => Effect.die("unexpected worker"),
			}),
		),
	);
});

test("workspace spawns from decoded unit-add input", () => {
	const [snapshot] = initialTransition(workspace);
	const event = { ...add, unexpected: "discarded" };
	const [, effects] = transition(workspace, snapshot, event);
	const spawn = effects.find((effect) => effect.type === "@xstate.spawn");
	expect(spawn).toMatchObject({
		input: { attemptLimit: 1, maxRounds: 1, interventionCap: 0 },
	});
	expect(spawn).not.toHaveProperty("input.unexpected");
});

test("a direct unit rejects invalid limits at initialization", () => {
	const { type: _, ...fields } = add;
	const input = { ...fields, holds: [], depsPassed: [], depsCancelled: [] };
	for (const [field, invalid] of invalidLimits) {
		for (const value of invalid) {
			const [snapshot, effects] = initialTransition(unit, {
				...input,
				[field]: value,
			});
			expect(snapshot.status, `${field}=${String(value)}`).toBe("error");
			expect(String(snapshot.error)).toContain(field);
			expect(effects.map(({ type }) => type)).not.toContain("@xstate.spawn");
		}
	}
	const [snapshot] = initialTransition(unit, input);
	expect(snapshot.context).toMatchObject({
		attemptLimit: 1,
		maxRounds: 1,
		interventionCap: 0,
	});
});

test("a direct task rejects an invalid attempt limit at initialization", () => {
	for (const value of invalidPositiveLimits) {
		const [snapshot, effects] = initialTransition(task, {
			spec: { ...spec, attemptLimit: value as number },
			holds: [],
		});
		expect(snapshot.status, String(value)).toBe("error");
		expect(String(snapshot.error)).toContain("attemptLimit");
		expect(effects.map(({ type }) => type)).not.toContain("@xstate.spawn");
	}
	const [snapshot] = initialTransition(task, { spec, holds: [] });
	expect(snapshot.context.spec.attemptLimit).toBe(1);
});
