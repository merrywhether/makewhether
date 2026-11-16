import { Schema } from "effect";
import { expect, test } from "vitest";
import { Decision, TierName, UnitId } from "../src/index.ts";

test("decisions may omit the resume phase in JSON", () => {
	for (const kind of ["resume", "raise-limit"] as const) {
		expect(
			Schema.decodeUnknownSync(Decision)(JSON.parse(`{"kind":"${kind}"}`)),
		).toEqual({ kind });
	}
	expect(
		Schema.decodeUnknownSync(Decision)(
			JSON.parse('{"kind":"amend","note":"note"}'),
		),
	).toEqual({ kind: "amend", note: "note" });
});

test("task ID components exclude separators from both colliding inputs", () => {
	const isUnitId = Schema.is(UnitId);
	const isTierName = Schema.is(TierName);

	expect(isUnitId("A")).toBe(true);
	expect(isTierName("y")).toBe(true);
	expect(isUnitId("A/1.implement.x")).toBe(false);
	expect(isTierName("x/1.implement.y")).toBe(false);
	for (const separator of ["/", ".", "#"]) {
		expect(isUnitId(`A${separator}B`)).toBe(false);
		expect(isTierName(`x${separator}y`)).toBe(false);
	}
});
