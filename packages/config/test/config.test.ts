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
