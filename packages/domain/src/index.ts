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
	effort: Schema.optional(Schema.String),
	timeLimitMs: Schema.optional(Schema.Number),
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

const UnitAddBase = Schema.Struct({
	id: Schema.String,
	repo: Schema.String,
	title: Schema.String,
	deps: Schema.Array(Schema.String),
	routes: Routes,
	maxRounds: Schema.Number,
	interventionCap: Schema.Number,
	attemptLimit: Schema.Number,
});
export const UnitAddEvent = Schema.Union([
	Schema.Struct({ ...UnitAddBase.fields, machine: Schema.String }),
	UnitAddBase,
]);
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
	| { type: "runner.parked" }
	| { type: "runner.report"; outcome: WorkerReport }
	| { type: "runner.failed"; reason: "crashed" | "lost"; detail: string }
	| {
			type: "runner.limit";
			holdId: string;
			scope: HoldScope;
			resetsAt: number;
			at: number;
	  };

export const ProcessIdentity = Schema.Struct({
	pid: Schema.Int.check(
		Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	),
	startedAt: Schema.String.check(Schema.isMinLength(1)),
});
export type ProcessIdentity = typeof ProcessIdentity.Type;

export const LockRecord = Schema.Struct({
	...ProcessIdentity.fields,
	token: Schema.String.check(Schema.isMinLength(1)),
	port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
});
export type LockRecord = typeof LockRecord.Type;

/** Declared waits and outcome handling for a machine state. */
export const MachineStateMeta = Schema.Struct({
	waitsOn: Schema.Literals(["task", "dependency", "hold"]),
	role: Schema.optional(Schema.String),
	phase: Schema.optional(Schema.String),
	handles: Schema.optional(Schema.Array(Schema.String)),
});
