// Load every credential from ONE AWS Secrets Manager secret into process.env,
// before the application module graph is imported.
//
// WHY THIS EXISTS
// The app reads its configuration from process.env at MODULE LOAD, not lazily:
//   * qr_signing.ts:12  reads QR_SIGNING_SECRET and THROWS if it is missing
//   * database_supabase.ts:96 reads the connection string and THROWS if missing
//   * auth/store.ts:113 decides Redis vs in-memory from REDIS_URL
// So any secret has to be in process.env before `import "./index.js"` is
// evaluated. Lambda has no native "inject a secret as an environment variable"
// mechanism, and the ECS alternative — enumerating every key as a `Secrets`
// entry in the task definition — fails the whole task if a key listed there is
// absent from the JSON, which makes every OPTIONAL variable a deployment
// landmine. One fetch of one JSON document avoids both problems.
//
// PRECEDENCE: a variable already present in process.env WINS. Infrastructure
// (the values set on the function / task definition in deploy/template.yaml)
// therefore beats the secret store, so PG_POOL_MAX and friends cannot be
// silently overridden by a stale value someone left in the secret.
//
// If APP_SECRET_ARN is not set this is a no-op, so a plain
// `docker run --env-file .env` still works unchanged.

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

/** Name of the env var holding the secret's ARN (or its plain name). */
const ARN_VAR = "APP_SECRET_ARN";

let loadPromise: Promise<LoadResult> | null = null;

export interface LoadResult {
	/** false when APP_SECRET_ARN was not set and nothing was fetched. */
	loaded: boolean;
	/** Keys copied into process.env (names only — never the values). */
	applied: string[];
	/** Keys present in the secret but already set in the environment. */
	skipped: string[];
}

async function fetchAndApply(secretId: string): Promise<LoadResult> {
	// Region comes from AWS_REGION, which both Lambda and Fargate set.
	const client = new SecretsManagerClient({});
	const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));

	const raw = out.SecretString
		?? (out.SecretBinary ? Buffer.from(out.SecretBinary).toString("utf8") : "");
	if (!raw) {
		throw new Error(`Secret ${secretId} is empty`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(
			`Secret ${secretId} is not JSON. It must be a flat object of ` +
			`{"ENV_VAR": "value"} pairs — see deploy/README.md "Secrets".`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Secret ${secretId} must be a JSON object, not an array or scalar`);
	}

	const applied: string[] = [];
	const skipped: string[] = [];
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (value === null || value === undefined) { continue; }
		if (typeof value === "object") {
			// A nested object would stringify to "[object Object]" and produce a
			// confusing downstream failure. Refuse it here instead.
			throw new Error(`Secret ${secretId} key "${key}" must be a string or number, not an object`);
		}
		if (process.env[key] !== undefined) {
			skipped.push(key);
			continue;
		}
		process.env[key] = String(value);
		applied.push(key);
	}

	// Deliberately not logged through pino: this runs before the app's logger has
	// its real configuration, and one line at startup is easier to find in
	// CloudWatch than a JSON object. Names only — never values.
	console.log(
		`[secrets] loaded ${applied.length} variable(s) from ${secretId}` +
		(skipped.length > 0 ? `; ${skipped.length} already set in the environment and left alone` : ""),
	);

	return { loaded: true, applied, skipped };
}

/**
 * Idempotent. Safe to call from more than one entrypoint; the fetch happens
 * once per container and warm invocations reuse the resolved result.
 *
 * A rotated secret is only picked up when a container is replaced. That is the
 * intended trade-off — see deploy/README.md "Rotating a credential".
 */
export function loadSecretsIntoEnv(): Promise<LoadResult> {
	if (loadPromise) { return loadPromise; }

	const secretId = process.env[ARN_VAR];
	if (!secretId) {
		console.log(`[secrets] ${ARN_VAR} not set — using the ambient environment as-is`);
		loadPromise = Promise.resolve({ loaded: false, applied: [], skipped: [] });
		return loadPromise;
	}

	loadPromise = fetchAndApply(secretId).catch((err: unknown) => {
		// Do NOT swallow this. Continuing would start the app against a half-empty
		// environment: qr_signing.ts would refuse to boot, or worse, an optional
		// integration would silently disable itself and look like a product bug.
		loadPromise = null;
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`[secrets] failed to load ${secretId}: ${message}`);
	});
	return loadPromise;
}
