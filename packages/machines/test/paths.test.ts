import type { Outcome, Routes } from "@makewhether/domain";
import { expect, test } from "vitest";
import { getAdjacencyMap } from "xstate/graph";
import { unit } from "../src/unit.ts";

const worker = { model: "agent", harness: "codex", account: "pro" } as const;
const person = {
	model: "person",
	harness: "person",
	account: "person",
} as const;
const routes: Routes = {
	implement: [{ tier: "implementer", workers: [worker], rules: {} }],
	verify: [{ tier: "verify", workers: [worker], rules: {} }],
	judge: [
		{ tier: "first", workers: [worker], rules: { pass: "up" } },
		{ tier: "second", workers: [worker], rules: {} },
	],
	intervene: [
		{ tier: "agent", workers: [worker], rules: {} },
		{ tier: "person", workers: [person], rules: {} },
	],
};
const input = {
	id: "U",
	repo: "repo",
	title: "unit",
	deps: ["D"],
	depsPassed: [],
	depsCancelled: [],
	routes,
	holds: [],
	maxRounds: 2,
	attemptLimit: 2,
	interventionCap: 2,
};
const outcomes: Outcome[] = [
	...(["done", "pass", "fail", "findings", "unsure"] as const).map(
		(verdict) => ({ kind: "done" as const, verdict, detail: "detail" }),
	),
	...(
		[
			"failed",
			"quota",
			"filtered",
			"timed-out",
			"refused",
			"crashed",
			"lost",
			"exhausted",
		] as const
	).map((kind) => ({ kind, detail: "detail" })),
	{
		kind: "done",
		verdict: "decision",
		decision: { kind: "resume", phase: undefined },
	},
	{
		kind: "done",
		verdict: "decision",
		decision: { kind: "amend", phase: undefined, note: "note" },
	},
	{
		kind: "done",
		verdict: "decision",
		decision: { kind: "raise-limit", phase: "judge" },
	},
	{ kind: "done", verdict: "decision", decision: { kind: "cancel" } },
];

const map = getAdjacencyMap(unit, {
	input,
	events: (snapshot) => [
		...outcomes.map((output) => ({
			type: "xstate.done.actor" as const,
			actorId: "task",
			sessionId: snapshot.children.task?.sessionId,
			output: {
				outcome: output,
				worker:
					snapshot.getInputs()["unit.intervene"]?.tier === 1 ? person : worker,
			},
		})),
		{ type: "dep.passed" as const, unit: "D" },
		{ type: "dep.cancelled" as const, unit: "D" },
		{
			type: "hold.placed" as const,
			hold: {
				id: "h",
				scope: { kind: "account" as const, account: "pro" },
				mode: "hard" as const,
			},
		},
		{ type: "hold.lifted" as const, holdId: "h" },
		{
			type: "hold.request" as const,
			holdId: "h",
			scope: { kind: "account" as const, account: "pro" },
			at: 0,
			resetsAt: 1,
		},
		{
			type: "answer" as const,
			taskId: "U/1.intervene.person",
			outcome: outcomes[0] ?? {
				kind: "exhausted" as const,
				detail: "fallback",
			},
		},
	],
	stopWhen: (snapshot) =>
		snapshot.context.round > 3 ||
		snapshot.context.seq > 14 ||
		snapshot.context.interventions > 4,
	serializeState: (snapshot) =>
		JSON.stringify([
			snapshot.status,
			snapshot.value,
			snapshot.context.round,
			snapshot.context.maxRounds,
			snapshot.context.interventions,
			snapshot.context.from,
			snapshot.context.depsPassed,
			snapshot.context.holds,
			Object.entries(snapshot.getInputs()).map(([key, value]) => [
				key,
				value?.tier,
			]),
		]),
});
const nodes = Object.values(map);

test("unit paths reach each state without errors", () => {
	expect([...new Set(nodes.map(({ state }) => state.value))].sort()).toEqual([
		"cancelled",
		"implement",
		"intervene",
		"judge",
		"passed",
		"queued",
		"verify",
	]);
	expect(nodes.filter(({ state }) => state.status === "error")).toEqual([]);
});

test("each active unit state has a progressing successor", () => {
	expect(
		nodes.filter(
			({ state, transitions }) =>
				state.status === "active" &&
				state.context.round <= 3 &&
				state.context.seq <= 14 &&
				state.context.interventions <= 4 &&
				!Object.keys(transitions).some((key) => {
					const next = transitions[key]?.state;
					return (
						next &&
						(next.value !== state.value || next.context.seq > state.context.seq)
					);
				}),
		),
	).toEqual([]);
});

test("intervention escalates invalid answers and respects its cap", () => {
	const tier = (state: (typeof nodes)[number]["state"]) =>
		state.getInputs()["unit.intervene"]?.tier;
	const interventions = nodes.filter(({ state }) => state.matches("intervene"));
	expect(
		interventions.some(({ state }) => state.context.interventions > 2),
	).toBe(true);
	expect(
		interventions.filter(
			({ state }) => state.context.interventions > 2 && tier(state) === 0,
		),
	).toEqual([]);
	for (const { state, transitions } of interventions) {
		if (tier(state) !== 0) continue;
		for (const key in transitions) {
			const transition = transitions[key];
			if (!transition) continue;
			if (
				transition.event.type === "xstate.done.actor" &&
				transition.state.matches("intervene")
			)
				expect(tier(transition.state)).not.toBe(0);
		}
	}
});
