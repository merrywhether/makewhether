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

const TaskIdPart = Schema.String.check(
	Schema.isPattern(/^[^/.#]*$/u, {
		message: "task ID components cannot contain /, . or #",
	}),
);
export const UnitId = TaskIdPart;
export const TierName = TaskIdPart;

export const Tier = Schema.Struct({
	tier: TierName,
	workers: Schema.NonEmptyArray(Worker),
	rules: Schema.Record(Schema.String, Schema.Literals(["up", "final"])),
	effort: Schema.optional(Schema.String),
	timeLimitMs: Schema.optional(Schema.Number),
});
export type Tier = typeof Tier.Type;

export const StructuralRoutes = Schema.Struct({
	implement: Schema.NonEmptyArray(Tier),
	verify: Schema.NonEmptyArray(Tier),
	judge: Schema.NonEmptyArray(Tier),
	intervene: Schema.NonEmptyArray(Tier),
});
export function hasPersonFinalTier(
	routes: typeof StructuralRoutes.Type,
): boolean {
	return (
		routes.intervene
			.at(-1)
			?.workers.every((worker) => worker.harness === "person") ?? false
	);
}
export const Routes = StructuralRoutes.check(
	Schema.makeFilter((routes) =>
		hasPersonFinalTier(routes)
			? undefined
			: {
					path: ["intervene"],
					issue: "final intervention tier must contain only person workers",
				},
	),
);
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

export const StuckReason = Schema.Literals([
	"invalid-final-tier",
	"invalid-unit-identity",
	"invalid-task-state",
	"non-person-final-worker",
	"unhandled-intervention",
	"unsupported-intervention-phase",
	"unauthorized-intervention-cancel",
]);
export type StuckReason = typeof StuckReason.Type;
export const StuckEpisode = Schema.Int.check(
	Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
export const StuckUnit = Schema.Struct({
	episode: StuckEpisode,
	reason: StuckReason,
	outcome: Schema.optional(Outcome),
});
export type StuckUnit = typeof StuckUnit.Type;

export const AttemptLimit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export const MaxRounds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export const InterventionCap = Schema.Natural;
export const defaultAttemptLimit = 2;

export const TaskSpec = Schema.Struct({
	taskId: Schema.String,
	phase: Phase,
	repo: Schema.String,
	title: Schema.String,
	tier: Schema.String,
	workers: Schema.NonEmptyArray(Worker),
	notes: Schema.Array(Schema.String),
	prior: Schema.Unknown,
	attemptLimit: AttemptLimit,
	effort: Schema.optional(Schema.String),
	timeLimitMs: Schema.optional(Schema.Number),
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

export const UnitDecisionEvent = Schema.Struct({
	unitId: Schema.String,
	episode: StuckEpisode,
	decision: Decision,
});
export type UnitDecisionEvent = typeof UnitDecisionEvent.Type;

export const InboxCommand = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("unit.add"),
		id: Schema.optional(Schema.String),
		brief: Schema.String,
		machine: Schema.String,
		repo: Schema.String,
		dependencies: Schema.Array(Schema.String),
	}),
	Schema.Struct({
		type: Schema.Literal("task.answer"),
		taskId: Schema.String,
		outcome: Outcome,
	}),
	Schema.Struct({
		type: Schema.Literal("hold.add"),
		kind: Schema.Literal("pause"),
		mode: Schema.Literals(["soft", "hard"]),
		scope: HoldScope,
	}),
	Schema.Struct({ type: Schema.Literal("hold.lift"), holdId: Schema.String }),
]);
export type InboxCommand = typeof InboxCommand.Type;

export const UnitAddEvent = Schema.Struct({
	id: UnitId,
	repo: Schema.String,
	title: Schema.String,
	deps: Schema.Array(UnitId),
	routes: Routes,
	maxRounds: MaxRounds,
	interventionCap: InterventionCap,
	attemptLimit: Schema.optional(AttemptLimit),
});
export const TaskAnswerEvent = Schema.Struct({
	taskId: Schema.String,
	outcome: Outcome,
});
export const HoldAddEvent = Schema.Struct({ hold: Hold });
export const HoldLiftEvent = Schema.Struct({ holdId: Schema.String });

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
			scope: HoldScope;
			resetsAt: number;
			at: number;
	  };

export const LockRecord = Schema.Struct({
	pid: Schema.Int.check(Schema.isGreaterThan(0)),
	startedAt: Schema.String.check(Schema.isMinLength(1)),
	token: Schema.String.check(Schema.isMinLength(1)),
	port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
});
export type LockRecord = typeof LockRecord.Type;
