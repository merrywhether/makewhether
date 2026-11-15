import { expect, test } from "vitest";
import { openStore } from "../src/index.ts";

test("checkpoint, log and consumed key commit together", () => {
	const store = openStore(":memory:");
	try {
		const first = { machine: "workspace", version: "1", snapshot: "{}", at: 1 };
		const entry = {
			at: 1,
			kind: "inbox",
			key: "key",
			event: "{}",
			address: "workspace",
		} as const;
		store.commit(first, [entry], {
			key: "key",
			at: 1,
			disposition: "accepted",
		});
		expect(store.getCheckpoint()).toEqual(first);
		expect(store.getDisposition("key")).toBe("accepted");
		expect(store.getAudit()).toEqual([entry]);
		expect(() =>
			store.commit({ ...first, snapshot: "changed" }, [entry], {
				key: "key",
				at: 2,
				disposition: "accepted",
			}),
		).toThrow();
		expect(store.getCheckpoint()).toEqual(first);
		expect(store.getAudit()).toEqual([entry]);
		expect(store.getDisposition("other")).toBeUndefined();
	} finally {
		store.close();
	}
});
