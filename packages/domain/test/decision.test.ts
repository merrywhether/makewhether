import { Schema } from "effect";
import { expect, test } from "vitest";
import { Decision } from "../src/index.ts";

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
