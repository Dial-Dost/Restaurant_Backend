import { resolveServeIntent } from "../order_intent.js";

/**
 * The item tick is a toggle, and a toggle is ambiguous once a tap can be
 * REPLAYED. A serve queued offline and delivered minutes later — after another
 * device already served the item — must still mean "serve"; a toggle resolved
 * against state at handling time would read "already served" and un-serve it.
 *
 * These pin the three cases so the fallback can never quietly reclaim the ones
 * that state their intent.
 */
describe("serve intent", () => {
	test("absent -> toggle, which is the online behaviour and must not change", () => {
		expect(resolveServeIntent({}, {})).toBe("toggle");
		expect(resolveServeIntent(undefined, undefined)).toBe("toggle");
		expect(resolveServeIntent({}, { note: "no salt" })).toBe("toggle");
		// A value that is neither the documented "1"/"0" nor a boolean is not an
		// intent: fall back rather than guess.
		expect(resolveServeIntent({ undo: "yes" }, {})).toBe("toggle");
		expect(resolveServeIntent({ undo: "" }, {})).toBe("toggle");
	});

	test("undo=1 / {undo:true} -> unserve, with no state read", () => {
		expect(resolveServeIntent({ undo: "1" }, {})).toBe("unserve");
		expect(resolveServeIntent({}, { undo: true })).toBe("unserve");
	});

	test("undo=0 / {undo:false} -> serve, with no state read", () => {
		// This is what the app now sends on the serve tap. It only renders for an
		// UNSERVED item, so the tap means serve — whenever it finally lands.
		expect(resolveServeIntent({ undo: "0" }, {})).toBe("serve");
		expect(resolveServeIntent({}, { undo: false })).toBe("serve");
	});

	test("the forced UNDO keeps winning when a client sends both", () => {
		// The long-standing explicit undo must not be demoted by a stray body
		// field; the destructive-looking direction is the one to honour.
		expect(resolveServeIntent({ undo: "1" }, { undo: false })).toBe("unserve");
	});

	test("query and body are read independently", () => {
		expect(resolveServeIntent({ undo: "0" }, { undo: undefined })).toBe("serve");
		expect(resolveServeIntent({ other: "x" }, { undo: true })).toBe("unserve");
	});
});
