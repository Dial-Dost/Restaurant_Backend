import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";

// argon2id password hashing with transparent support for not-yet-migrated
// legacy plaintext credentials. Stored secrets are argon2 strings ("$argon2...");
// legacy rows are compared directly once and rehashed by the caller on login.

export function isHashedPassword(stored: string | null | undefined): boolean {
	return typeof stored === "string" && stored.startsWith("$argon2");
}

export async function hashPassword(plain: string): Promise<string> {
	return argon2Hash(plain);
}

export async function verifyPassword(
	stored: string | null | undefined,
	plain: string,
): Promise<boolean> {
	if (typeof stored !== "string" || stored.length === 0) {
		return false;
	}
	if (isHashedPassword(stored)) {
		try {
			return await argon2Verify(stored, plain);
		} catch {
			return false;
		}
	}
	return stored === plain; // legacy plaintext, pending upgrade on next login
}
