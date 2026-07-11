import 'dotenv/config';
import { hashPassword } from "../auth/password.js";
import { platformQuery, platformDbConfigured } from "../platform/db.js";

// Bootstrap / reset a platform (SaaS) admin.
// Usage: tsx scripts/create-platform-admin.ts <email> <password> [name]
// Requires PLATFORM_DATABASE_URL and migration 004 applied.
async function main() {
	const [, , email, password, name] = process.argv;
	if (!email || !password) {
		console.error("Usage: tsx scripts/create-platform-admin.ts <email> <password> [name]");
		process.exit(1);
	}
	if (!platformDbConfigured()) {
		console.error("PLATFORM_DATABASE_URL is not set.");
		process.exit(1);
	}

	const hash = await hashPassword(password);
	await platformQuery(
		`
			insert into platform.admins (email, pass_hash, name)
			values ($1, $2, $3)
			on conflict (email) do update
				set pass_hash = excluded.pass_hash, name = excluded.name, active = true
		`,
		[email.trim().toLowerCase(), hash, name ?? null],
	);
	console.log(`Platform admin upserted: ${email.trim().toLowerCase()}`);
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
