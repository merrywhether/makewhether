import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Routes } from "@makewhether/domain";
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
	maxRounds: Schema.Int.check(Schema.isGreaterThan(0)),
	interventionCap: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	attemptLimit: Schema.Int.check(Schema.isGreaterThan(0)),
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
		attemptLimit: 2,
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
