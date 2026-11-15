import { Schema } from "effect";

export const Phase = Schema.Literals([
	"implement",
	"verify",
	"judge",
	"intervene",
]);
export type Phase = typeof Phase.Type;

export const WorkPhase = Schema.Literals(["implement", "verify", "judge"]);
export type WorkPhase = typeof WorkPhase.Type;

export const Harness = Schema.Literals(["codex", "claude", "shell", "person"]);
export const Worker = Schema.Struct({
	model: Schema.String,
	harness: Harness,
	account: Schema.String,
});
export type Worker = typeof Worker.Type;

export const Tier = Schema.Struct({
	tier: Schema.String,
	workers: Schema.NonEmptyArray(Worker),
	rules: Schema.Record(Schema.String, Schema.Literals(["up", "final"])),
});
export type Tier = typeof Tier.Type;

export const Routes = Schema.Struct({
	implement: Schema.NonEmptyArray(Tier),
	verify: Schema.NonEmptyArray(Tier),
	judge: Schema.NonEmptyArray(Tier),
	intervene: Schema.NonEmptyArray(Tier),
});
export type Routes = typeof Routes.Type;

export const HoldScope = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("account"), account: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal("model"),
		account: Schema.String,
		model: Schema.String,
	}),
	Schema.Struct({ kind: Schema.Literal("repo"), repo: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("all") }),
]);
export type HoldScope = typeof HoldScope.Type;

export const Hold = Schema.Struct({
	id: Schema.String,
	scope: HoldScope,
	mode: Schema.Literals(["soft", "hard"]),
});
export type Hold = typeof Hold.Type;

export const Decision = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("resume"),
		phase: Schema.optional(WorkPhase),
	}),
	Schema.Struct({
		kind: Schema.Literal("amend"),
		phase: Schema.optional(WorkPhase),
		note: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("raise-limit"),
		phase: Schema.optional(WorkPhase),
	}),
	Schema.Struct({
		kind: Schema.Literal("cancel"),
		analysis: Schema.optional(Schema.String),
	}),
]);
export type Decision = typeof Decision.Type;

export const WorkerReport = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("done"),
		verdict: Schema.Literals(["done", "pass", "fail", "findings", "unsure"]),
		detail: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("done"),
		verdict: Schema.Literal("decision"),
		decision: Decision,
	}),
	Schema.Struct({
		kind: Schema.Literals(["failed", "filtered", "timed-out", "refused"]),
		detail: Schema.String,
	}),
]);
export type WorkerReport = typeof WorkerReport.Type;

export const Outcome = Schema.Union([
	WorkerReport,
	Schema.Struct({
		kind: Schema.Literals(["quota", "crashed", "lost", "exhausted"]),
		detail: Schema.String,
	}),
]);
export type Outcome = typeof Outcome.Type;

export const TaskSpec = Schema.Struct({
	taskId: Schema.String,
	phase: Phase,
	repo: Schema.String,
	title: Schema.String,
	tier: Schema.String,
	workers: Schema.NonEmptyArray(Worker),
	notes: Schema.Array(Schema.String),
	prior: Schema.Unknown,
	attemptLimit: Schema.Number,
});
export type TaskSpec = typeof TaskSpec.Type;

/** Test whether a hold covers a worker in a repository. */
export function matchesHold(
	scope: HoldScope,
	worker: Worker,
	repo: string,
): boolean {
	if (worker.harness === "person") return false;
	switch (scope.kind) {
		case "account":
			return scope.account === worker.account;
		case "model":
			return scope.account === worker.account && scope.model === worker.model;
		case "repo":
			return scope.repo === repo;
		case "all":
			return true;
	}
}
