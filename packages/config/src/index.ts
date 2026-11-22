import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	AttemptLimit,
	defaultAttemptLimit,
	InterventionCap,
	MaxRounds,
	Routes,
} from "@makewhether/domain";
import { Schema } from "effect";

const worker = { harness: "codex", model: "fake", account: "fake" } as const;
const person = {
	harness: "person",
	model: "person",
	account: "person",
} as const;
const tier = { tier: "fake", workers: [worker] as const, rules: {} };

export const UnitSettings = Schema.Struct({
	routes: Routes,
	maxRounds: MaxRounds,
	interventionCap: InterventionCap,
	attemptLimit: AttemptLimit,
});
export type UnitSettings = typeof UnitSettings.Type;

/** Resolve the built-in fake-worker settings for a new unit. */
export function getUnitSettings(): UnitSettings {
	return {
		routes: {
			implement: [tier],
			verify: [tier],
			judge: [tier],
			intervene: [{ tier: "person", workers: [person], rules: {} }],
		},
		maxRounds: 2,
		interventionCap: 2,
		attemptLimit: defaultAttemptLimit,
	};
}

/** Load and validate the default export of a TypeScript settings module. */
export async function loadSettings(
	path: string | undefined,
): Promise<UnitSettings> {
	if (!path) return getUnitSettings();
	const loaded: { default?: unknown } = await import(
		pathToFileURL(resolve(path)).href
	);
	return Schema.decodeUnknownSync(UnitSettings)(loaded.default);
}
