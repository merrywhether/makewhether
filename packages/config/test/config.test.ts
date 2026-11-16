import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { getUnitSettings, loadSettings } from "../src/index.ts";

test("loads and validates a TypeScript settings module", async () => {
	const dir = mkdtempSync(join(tmpdir(), "makew-config-"));
	try {
		expect((await loadSettings(undefined)).attemptLimit).toBe(2);
		const file = join(dir, "settings.ts");
		const settings = { ...getUnitSettings(), maxRounds: 7, attemptLimit: 4 };
		writeFileSync(file, `export default ${JSON.stringify(settings)};`);
		expect(await loadSettings(file)).toEqual(settings);
		const invalid = join(dir, "invalid.ts");
		writeFileSync(
			invalid,
			`export default ${JSON.stringify({ ...settings, attemptLimit: 0 })};`,
		);
		await expect(loadSettings(invalid)).rejects.toThrow();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("settings reject agent-only and mixed final intervention tiers", async () => {
	const dir = mkdtempSync(join(tmpdir(), "makew-config-"));
	try {
		const settings = getUnitSettings();
		const agent = settings.routes.implement[0];
		const person = settings.routes.intervene[0];
		const cases = [
			{ name: "agent-only", final: agent },
			{
				name: "mixed",
				final: { ...person, workers: [...agent.workers, ...person.workers] },
			},
			{ name: "person-only", final: person },
			{ name: "invalid-tier-name", final: { ...person, tier: "person.1" } },
		];
		for (const { name, final } of cases) {
			const file = join(dir, `${name}.ts`);
			const configured = {
				...settings,
				routes: { ...settings.routes, intervene: [agent, final] },
			};
			writeFileSync(file, `export default ${JSON.stringify(configured)};`);
			if (name === "person-only")
				expect(await loadSettings(file)).toEqual(configured);
			else
				await expect(loadSettings(file)).rejects.toThrow(
					name === "invalid-tier-name"
						? "task ID components cannot contain"
						: "final intervention tier must contain only person workers",
				);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
