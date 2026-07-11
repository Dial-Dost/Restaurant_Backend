import assert from "node:assert";
import { hashPassword, verifyPassword, isHashedPassword } from "../auth/password.js";

// Unit test for the password helpers. No DB/Redis required — runnable anywhere
// argon2 loads. Run with: npm run test:password
async function main() {
	const hash = await hashPassword("s3cret!");
	assert.ok(hash.startsWith("$argon2"), "hash should be an argon2 string");
	assert.ok(isHashedPassword(hash), "isHashedPassword true for an argon2 hash");
	assert.ok(!isHashedPassword("plaintext"), "isHashedPassword false for plaintext");
	assert.ok(!isHashedPassword(null), "isHashedPassword false for null");

	// Verify against the hash.
	assert.strictEqual(await verifyPassword(hash, "s3cret!"), true, "correct password verifies");
	assert.strictEqual(await verifyPassword(hash, "wrong"), false, "wrong password rejected");

	// Two hashes of the same password differ (random salt) but both verify.
	const hash2 = await hashPassword("s3cret!");
	assert.notStrictEqual(hash, hash2, "salts make hashes differ");
	assert.strictEqual(await verifyPassword(hash2, "s3cret!"), true, "second hash verifies");

	// Legacy plaintext support (transparent migration path).
	assert.strictEqual(await verifyPassword("changeme", "changeme"), true, "legacy plaintext matches");
	assert.strictEqual(await verifyPassword("changeme", "nope"), false, "legacy plaintext mismatch rejected");

	// Invalid stored values.
	assert.strictEqual(await verifyPassword("", "x"), false, "empty stored rejected");
	assert.strictEqual(await verifyPassword(null, "x"), false, "null stored rejected");
	assert.strictEqual(await verifyPassword(undefined, "x"), false, "undefined stored rejected");

	console.log("password_hashing_test: all assertions passed");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
