import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { getUnitSettings, loadSettings } from "../src/index.ts";

test("loads and validates a TypeScript settings module", async () => {
	const dir = mkdtempSync(join(tmpdir(), "makew-config-"));
	try {
		expect(await loadSettings(undefined)).toMatchObject({
			attemptLimit: 2,
			maxRounds: 2,
			interventionCap: 2,
		});
		const file = join(dir, "settings.ts");
		const settings = {
			...getUnitSettings(),
			attemptLimit: 1,
			maxRounds: 1,
			interventionCap: 0,
		};
		writeFileSync(file, `export default ${JSON.stringify(settings)};`);
		expect(await loadSettings(file)).toEqual(settings);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("settings reject limits outside the supported integer ranges", async () => {
	const dir = mkdtempSync(join(tmpdir(), "makew-config-"));
	try {
		for (const [field, belowMinimum] of [
			["attemptLimit", 0],
			["maxRounds", 0],
			["interventionCap", -1],
		] as const) {
			for (const [index, source] of [
				"Infinity",
				"NaN",
				'"never"',
				'JSON.parse("1e309")',
				"1.5",
				"Number.MAX_SAFE_INTEGER + 1",
				belowMinimum,
			].entries()) {
				const file = join(dir, `${field}-${index}.ts`);
				writeFileSync(
					file,
					`export default { ...${JSON.stringify(getUnitSettings())}, ${field}: ${source} };`,
				);
				await expect(
					loadSettings(file),
					`${field} = ${source}`,
				).rejects.toThrow(field);
			}
		}
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
