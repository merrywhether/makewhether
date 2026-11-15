import { pathToFileURL } from "node:url";
import { loadSettings } from "@makewhether/config";
import { MachineStateMeta } from "@makewhether/domain";
import { Schema } from "effect";

const State = Schema.Struct({
	type: Schema.optional(Schema.String),
	meta: Schema.optional(Schema.Unknown),
	invoke: Schema.optional(Schema.Unknown),
	states: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const Machine = Schema.Struct({
	config: Schema.Struct({ states: Schema.Record(Schema.String, State) }),
});

/** Check declared waits and phase routing on a TypeScript machine module. */
export async function checkMachine(file: string, settingsPath?: string) {
	const loaded: { default?: unknown; unit?: unknown; machine?: unknown } =
		await import(pathToFileURL(file).href);
	const machine = Schema.decodeUnknownSync(Machine)(
		loaded.default ?? loaded.machine ?? loaded.unit,
	);
	const errors: string[] = [];
	let intervention = false;
	function visit(states: Record<string, unknown>, prefix = "") {
		for (const [key, raw] of Object.entries(states)) {
			const name = prefix ? `${prefix}.${key}` : key;
			const state = Schema.decodeUnknownSync(State)(raw);
			if (state.states) visit(state.states, name);
			if (state.type === "final" || state.states) continue;
			let meta: typeof MachineStateMeta.Type;
			try {
				meta = Schema.decodeUnknownSync(MachineStateMeta)(state.meta);
			} catch {
				errors.push(`${name}: missing or invalid waitsOn metadata`);
				continue;
			}
			if (meta.phase === "intervene") intervention = true;
			if (meta.role || meta.phase) {
				if (!meta.role || !meta.phase)
					errors.push(`${name}: role phases require role and phase`);
				if (!meta.handles?.includes("up"))
					errors.push(`${name}: role phase cannot move up`);
				const invocations = Array.isArray(state.invoke)
					? state.invoke
					: [state.invoke];
				const completes = invocations.some((invocation: unknown) => {
					if (
						!invocation ||
						typeof invocation !== "object" ||
						!("onDone" in invocation)
					)
						return false;
					const transition = invocation.onDone;
					return (
						typeof transition === "function" ||
						typeof transition === "string" ||
						(typeof transition === "object" &&
							transition != null &&
							Object.keys(transition).length > 0)
					);
				});
				if (!completes)
					errors.push(`${name}: role phase has no task completion route`);
			}
		}
	}
	visit(machine.config.states);
	if (!intervention) errors.push("machine has no intervene phase");
	const settings = await loadSettings(settingsPath);
	const last = settings.routes.intervene.at(-1);
	const warnings = last?.workers.some((worker) => worker.harness === "person")
		? []
		: ["intervene route does not end with a person"];
	return { errors, warnings };
}
