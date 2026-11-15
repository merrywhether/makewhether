import {
	Hold,
	type Outcome,
	type Phase,
	Routes,
	type Tier,
	type Worker,
	type WorkPhase,
} from "@makewhether/domain";
import { Schema } from "effect";

export const UnitInput = Schema.Struct({
	id: Schema.String,
	repo: Schema.String,
	title: Schema.String,
	deps: Schema.Array(Schema.String),
	depsPassed: Schema.Array(Schema.String),
	depsCancelled: Schema.Array(Schema.String),
	routes: Routes,
	holds: Schema.Array(Hold),
	maxRounds: Schema.Number,
	attemptLimit: Schema.Number,
	interventionCap: Schema.Number,
});
export type UnitInput = typeof UnitInput.Type;

export const UnitContext = Schema.Struct({
	...UnitInput.fields,
	seq: Schema.Number,
	round: Schema.Number,
	notes: Schema.Array(Schema.String),
	from: Schema.Literals(["implement", "verify", "judge"]),
	interventions: Schema.Number,
	cancelledDependency: Schema.UndefinedOr(Schema.String),
});
type UnitContext = typeof UnitContext.Type;

const PhaseInput = Schema.Struct({
	tier: Schema.Number,
	taskId: Schema.String,
	prior: Schema.Unknown,
});
type PhaseInput = typeof PhaseInput.Type;
export const phaseState = { schemas: { input: PhaseInput } };
type EnterPhase = {
	[P in Phase]: {
		target: P;
		reenter: true;
		context: UnitContext;
		input: PhaseInput;
	};
}[Phase];
type Next = EnterPhase | { target: "passed" } | { target: "cancelled" };

function getTier(context: UnitContext, phase: Phase, tier: number): Tier {
	const step = context.routes[phase][tier];
	if (!step) throw new Error(`missing ${phase} tier ${tier}`);
	return step;
}

export function enter(
	context: UnitContext,
	phase: Phase,
	patch: Partial<UnitContext> = {},
	tier = 0,
	prior: unknown = undefined,
): EnterPhase {
	const next = { ...context, ...patch, seq: context.seq + 1 };
	const step = getTier(next, phase, tier);
	const input = {
		tier,
		taskId: `${next.id}/${next.seq}.${phase}.${step.tier}`,
		prior,
	};
	const transition = { reenter: true as const, context: next, input };
	switch (phase) {
		case "implement":
			return { ...transition, target: "implement" };
		case "verify":
			return { ...transition, target: "verify" };
		case "judge":
			return { ...transition, target: "judge" };
		case "intervene":
			return { ...transition, target: "intervene" };
	}
}

function intervene(
	context: UnitContext,
	from: WorkPhase,
	reason: string,
	prior: unknown,
): EnterPhase {
	const interventions = context.interventions + 1;
	const tier =
		interventions > context.interventionCap
			? context.routes.intervene.length - 1
			: 0;
	return enter(context, "intervene", { from, interventions }, tier, {
		reason,
		prior,
	});
}

export function rework(
	context: UnitContext,
	from: WorkPhase,
	outcome: Outcome,
): Next {
	if (context.round >= context.maxRounds)
		return intervene(context, from, "round limit reached", outcome);
	const detail = "detail" in outcome ? outcome.detail : outcome.decision.kind;
	return enter(context, "implement", {
		round: context.round + 1,
		notes: [...context.notes, detail],
	});
}

export function decide(context: UnitContext, outcome: Outcome): Next {
	if (outcome.kind !== "done" || outcome.verdict !== "decision")
		throw new Error("expected intervention decision");
	const decision = outcome.decision;
	if (decision.kind === "cancel") return { target: "cancelled" };
	const phase = decision.phase ?? context.from;
	switch (decision.kind) {
		case "resume":
			return enter(context, phase);
		case "amend":
			return enter(context, phase, {
				round: context.round + 1,
				notes: [...context.notes, decision.note],
			});
		case "raise-limit":
			return enter(context, phase, {
				maxRounds: context.maxRounds + 1,
				round: context.round + 1,
			});
	}
}

export function taskInput(
	context: UnitContext,
	phase: Phase,
	input: PhaseInput | undefined,
) {
	if (!input) throw new Error(`phase ${phase} has no input`);
	const step = getTier(context, phase, input.tier);
	return {
		holds: context.holds,
		spec: {
			taskId: input.taskId,
			phase,
			repo: context.repo,
			title: context.title,
			tier: step.tier,
			workers: step.workers,
			notes: context.notes,
			prior: input.prior,
			attemptLimit: context.attemptLimit,
			effort: step.effort,
			timeLimitMs: step.timeLimitMs,
		},
	};
}

type Handler = (context: UnitContext, outcome: Outcome) => Next;
export function route(
	context: UnitContext,
	phase: Phase,
	input: PhaseInput | undefined,
	result: { outcome: Outcome; worker: Worker },
	handlers: Partial<Record<string, Handler>>,
	allowJudge = true,
): Next {
	if (!input) throw new Error(`phase ${phase} has no input`);
	const { outcome, worker } = result;
	const steps = context.routes[phase];
	const step = getTier(context, phase, input.tier);
	const key = outcome.kind === "done" ? outcome.verdict : outcome.kind;
	const rule = step.rules[key] ?? (key === "unsure" ? "up" : "final");
	const prior = { tier: step.tier, outcome };
	if (rule === "up" && input.tier + 1 < steps.length)
		return enter(context, phase, {}, input.tier + 1, prior);
	const unauthorizedCancel =
		phase === "intervene" &&
		outcome.kind === "done" &&
		outcome.verdict === "decision" &&
		outcome.decision.kind === "cancel" &&
		worker.harness !== "person";
	const unsupportedPhase =
		!allowJudge &&
		phase === "intervene" &&
		outcome.kind === "done" &&
		outcome.verdict === "decision" &&
		outcome.decision.kind !== "cancel" &&
		outcome.decision.phase === "judge";
	const handler =
		rule === "up" || unauthorizedCancel || unsupportedPhase
			? undefined
			: handlers[key];
	if (handler) return handler(context, outcome);
	if (phase === "intervene")
		return enter(
			context,
			phase,
			{},
			Math.min(input.tier + 1, steps.length - 1),
			prior,
		);
	return intervene(context, phase, `unhandled outcome ${key}`, outcome);
}
