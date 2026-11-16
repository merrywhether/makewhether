import type { RunnerEvent, RunnerInput, Worker } from "@makewhether/domain";
import { createEffectActor, waitFor } from "@xstate/effect";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { Workers } from "../src/runner.ts";
import { unit } from "../src/unit.ts";
import {
	decide,
	parkUnit,
	recoverStuck,
	route,
	stuckDecisionProblem,
	type UnitContext,
} from "../src/unit-logic.ts";

const agent: Worker = { model: "agent", harness: "codex", account: "a" };
const person: Worker = { model: "person", harness: "person", account: "p" };
const tier = (worker: Worker) => ({
	tier: worker.account,
	workers: [worker] as const,
	rules: {},
});
const context: UnitContext = {
	id: "U",
	repo: "r",
	title: "t",
	deps: [],
	depsPassed: [],
	depsCancelled: [],
	routes: {
		implement: [tier(agent)],
		verify: [tier(agent)],
		judge: [tier(agent)],
		intervene: [tier(agent), tier(person)],
	},
	holds: [],
	maxRounds: 3,
	attemptLimit: 1,
	interventionCap: 2,
	seq: 5,
	round: 2,
	notes: [],
	from: "verify",
	interventions: 2,
	cancelledDependency: undefined,
};
const phaseInput = { tier: 1, taskId: "t", prior: undefined };
const resume = {
	kind: "done",
	verdict: "decision",
	decision: { kind: "resume" },
} as const;

test("ordinary decisions preserve the intervention count; recovery resets only it", () => {
	const ordinary = decide(context, resume);
	expect(ordinary.target).toBe("verify");
	if (!("context" in ordinary)) throw new Error("expected phase");
	expect(ordinary.context.interventions).toBe(2);
	const stuck = parkUnit(context, "unhandled-intervention").context;
	const recovery = recoverStuck(stuck, {
		unitId: "U",
		episode: 1,
		decision: { kind: "resume" },
	});
	if (!("context" in recovery)) throw new Error("expected phase");
	expect([
		recovery.context.interventions,
		recovery.context.round,
		recovery.context.maxRounds,
	]).toEqual([0, 2, 3]);
});

test("stuck admission binds episode, identity and machine phase", () => {
	const stuck = parkUnit(context, "unhandled-intervention").context;
	expect(
		stuckDecisionProblem(
			stuck,
			{ unitId: "U", episode: 2, decision: { kind: "resume" } },
			true,
		),
	).toBeDefined();
	expect(
		stuckDecisionProblem(
			stuck,
			{ unitId: "X", episode: 1, decision: { kind: "resume" } },
			true,
		),
	).toBeDefined();
	expect(
		stuckDecisionProblem(
			stuck,
			{ unitId: "U", episode: 1, decision: { kind: "resume", phase: "judge" } },
			false,
		),
	).toBeDefined();
	expect(
		stuckDecisionProblem(
			stuck,
			{ unitId: "U", episode: 1, decision: { kind: "resume", phase: "judge" } },
			true,
		),
	).toBeUndefined();
	const invalid = parkUnit(context, "invalid-unit-identity").context;
	expect(
		stuckDecisionProblem(
			invalid,
			{ unitId: "U", episode: 1, decision: { kind: "resume" } },
			true,
		),
	).toBeDefined();
	expect(
		stuckDecisionProblem(
			invalid,
			{ unitId: "U", episode: 1, decision: { kind: "cancel" } },
			true,
		),
	).toBeUndefined();
});

test("final intervention parks invalid routes, nonperson results, and unhandled outcomes", () => {
	const invalid = {
		...context,
		routes: { ...context.routes, intervene: [tier(agent)] as const },
	};
	expect(
		route(
			invalid,
			"intervene",
			{ ...phaseInput, tier: 0 },
			{ outcome: resume, worker: agent },
			{ decision: decide },
		),
	).toMatchObject({
		target: "stuck",
		context: { stuck: { reason: "invalid-final-tier" } },
	});
	expect(
		route(
			context,
			"intervene",
			phaseInput,
			{ outcome: resume, worker: agent },
			{ decision: decide },
		),
	).toMatchObject({
		target: "stuck",
		context: { stuck: { reason: "non-person-final-worker" } },
	});
	expect(
		route(
			context,
			"intervene",
			phaseInput,
			{
				outcome: { kind: "done", verdict: "unsure", detail: "?" },
				worker: person,
			},
			{ decision: decide },
		),
	).toMatchObject({
		target: "stuck",
		context: { stuck: { reason: "unhandled-intervention" } },
	});
});

test("parking a unit never reuses an episode present in its saved state", () => {
	const first = parkUnit(context, "unhandled-intervention").context;
	const mismatched = {
		...first,
		stuckEpisode: 2,
		stuck: { ...first.stuck, episode: 3 },
	};
	expect(parkUnit(mismatched, "invalid-task-state").context.stuck.episode).toBe(
		4,
	);
	expect(() =>
		parkUnit(
			{ ...context, stuckEpisode: Number.MAX_SAFE_INTEGER },
			"invalid-task-state",
		),
	).toThrow("cannot allocate a stuck episode for unit U");
});

test("the unit parks before invoking an invalid final tier", async () => {
	const calls: string[] = [];
	const workers = {
		run: (input: RunnerInput, emit: (event: RunnerEvent) => void) =>
			Effect.gen(function* () {
				calls.push(input.spec.phase);
				if (input.spec.phase === "intervene") return yield* Effect.never;
				emit({ type: "runner.report", outcome: resume });
			}),
	};
	await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(unit, {
				input: {
					...context,
					deps: [],
					routes: { ...context.routes, intervene: [tier(agent)] },
				},
			});
			const parked = yield* waitFor(
				actor,
				(snapshot) => snapshot.matches("stuck"),
				{ timeout: "1 second" },
			);
			expect(parked.context.stuck?.reason).toBe("invalid-final-tier");
			expect(parked.children).toEqual({});
			expect(parked.timers).toHaveLength(0);
		}).pipe(Effect.scoped, Effect.provideService(Workers, workers)),
	);
	expect(calls).toEqual(["implement"]);
});

test("a live worker reattaching at the final tier cannot supply a decision", async () => {
	const interventions: string[] = [];
	let restarting = false;
	const workers = {
		run: (input: RunnerInput, emit: (event: RunnerEvent) => void) =>
			Effect.gen(function* () {
				if (input.spec.phase === "intervene") {
					interventions.push(input.key);
					emit({ type: "runner.started", sessionId: "saved-session" });
					if (!restarting) return yield* Effect.never;
				}
				emit({ type: "runner.report", outcome: resume });
			}),
	};
	const run = <A, E>(program: Effect.Effect<A, E, Workers>) =>
		Effect.runPromise(program.pipe(Effect.provideService(Workers, workers)));
	const saved = await run(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(unit, { input: context });
			yield* waitFor(actor, (snapshot) => snapshot.matches("intervene"), {
				timeout: "1 second",
			});
			const task = actor.getSnapshot().children.task;
			if (!task) throw new Error("missing intervention task");
			yield* waitFor(
				task,
				(snapshot) => snapshot.context.sessionId === "saved-session",
				{ timeout: "1 second" },
			);
			return JSON.parse(JSON.stringify(actor.getPersistedSnapshot()));
		}).pipe(Effect.scoped),
	);

	// The task already has a live agent. Its saved tier now resolves to the
	// person-only tier in the unit. Bypass the host check to exercise onDone.
	saved.context.routes.intervene = [tier(person)];
	restarting = true;
	await run(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(unit, { snapshot: saved });
			const parked = yield* waitFor(
				actor,
				(snapshot) => snapshot.matches("stuck"),
				{ timeout: "1 second" },
			);
			expect(parked.context.stuck).toMatchObject({
				reason: "non-person-final-worker",
				outcome: resume,
			});
			expect(parked.children).toEqual({});
		}).pipe(Effect.scoped),
	);
	expect(interventions).toEqual(["U/2.intervene.a#1", "U/2.intervene.a#1"]);
});
