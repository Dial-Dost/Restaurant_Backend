// Restaurant provisioning — the ONE path that brings a tenant into existence.
//
// WHY THIS FILE EXISTS: until now the only way to create a restaurant was the
// PUBLIC self-serve route POST /auth/register-restaurant. The operator console
// needs the same capability, and a second copy of "pre-check, seed, start a
// trial" would drift: the pre-check below is a SECURITY CONTROL (see the comment
// on it), and a fork that lost it would silently rename an existing tenant and
// reset its owner's password. So both callers go through provisionRestaurant.
//
// It sits at the repository root rather than in routes/ because platform/routes.ts
// (the control plane) and routes/auth.ts (the tenant plane) are deliberately
// separate worlds and neither should import the other's route module. It stays
// OUT of database_supabase.ts because that file's own rule (:1251) keeps data
// access there to tenant SQL, and the trial start below is a PLATFORM-pool call.
//
// Which pool runs what, because it is not obvious and it is load-bearing:
//   * EnsureRestaurantSeed runs on the TENANT pool as app_runtime and sets
//     app.res_id itself inside its transaction. platform_runtime holds no INSERT
//     on "Restaurant" and no grants at all on "Outlets"/"Employees"/"Login"
//     (migrations/004_platform_schema.sql:75), so the control plane physically
//     cannot seed a tenant with its own connection — it has to come through here.
//   * startTrialIfMissing runs on the PLATFORM pool.

import { EnsureRestaurantSeed, getRestaurantIdFromUsername } from "./database_supabase.js";
import { logger } from "./observability.js";
import { startTrialIfMissing } from "./platform/tenant_billing.js";

// A restaurant's slug is derived from a display name by stripping everything
// that is not a lowercase letter or digit. It is the value stored in
// "Restaurant".res_username, which carries the UNIQUE constraint
// Restaurant_res_username_key (migrations/000_base_schema.sql:430) and is baked
// into every printed QR URL and feedback link, so it is effectively permanent.
export function normalizeRestaurantSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Thrown when the slug is already registered. Callers turn this into a 409 —
// with a hand-typed slug this is a normal, correctable outcome, not a fault.
export class RestaurantExistsError extends Error {
  constructor(public readonly slug: string) {
    super(`Restaurant slug "${slug}" is already registered.`);
    this.name = "RestaurantExistsError";
  }
}

export interface ProvisionRestaurantInput {
  /** Display name. Stored as "Restaurant".res_name and used for the outlet name. */
  restaurantName: string;
  /** Already-normalized slug (callers must run it through normalizeRestaurantSlug). */
  slug: string;
  /** The first admin's display name. */
  adminName: string;
  /** The first admin's login username ("Login".emp_username). */
  adminUsername: string;
  /** Plaintext; EnsureRestaurantSeed argon2-hashes it. Never stored or logged here. */
  password: string;
  profile?: {
    address?: string;
    phone?: string;
    email?: string;
    hours?: string;
  };
  /**
   * Start a trial subscription when the tenant has none. True for self-serve
   * signup; false when the caller is about to assign a sold plan itself (a trial
   * inserted first would just be overwritten a moment later).
   */
  startTrial?: boolean;
}

export interface ProvisionedRestaurant {
  /** "Restaurant".id. Null only if the row could not be re-read after seeding. */
  res_id: string | null;
  /** "Restaurant".res_username — the slug that was actually written. */
  res_username: string;
}

export async function provisionRestaurant(
  input: ProvisionRestaurantInput,
): Promise<ProvisionedRestaurant> {
  const slug = input.slug;

  // EXISTENCE PRE-CHECK — A SECURITY CONTROL, NOT A UX NICETY. DO NOT REMOVE.
  //
  // EnsureRestaurantSeed is an UPSERT: on an existing slug it UPDATES res_name
  // and main_office_add, UPDATES the matching employee, and OVERWRITES that
  // employee's emp_pass (database_supabase.ts:25025, :25146, :25172). Without
  // this check, anyone who can reach a provisioning route could rename a live
  // tenant and take over its owner login, with no error and no visible symptom.
  //
  // The check is a direct read of the UNIQUE column the database itself
  // protects. It is still TOCTOU — two concurrent callers can both pass it — and
  // that race is closed by Restaurant_res_username_key, whose 23505 callers map
  // to the same 409.
  const existing = await getRestaurantIdFromUsername(slug);
  if (existing) {
    throw new RestaurantExistsError(slug);
  }

  await EnsureRestaurantSeed({
    id: slug,
    name: input.restaurantName,
    admin: {
      employeeId: input.adminUsername,
      name: input.adminName,
      password: input.password,
    },
    tables: [],
    ...(input.profile ? { profile: input.profile } : {}),
  });

  // Re-read the uuid the seed just wrote. Best-effort: the tenant exists and is
  // usable either way, so a blip here must not turn a successful creation into a
  // 500. Callers that need the id (the operator console keys every action on it)
  // decide for themselves what a null means.
  let resId: string | null = null;
  try {
    resId = await getRestaurantIdFromUsername(slug);
  } catch (err) {
    logger.warn({ err }, "resolve_new_restaurant_id_failed");
  }

  // Start a trial on the default plan (best-effort; an operator can reassign the
  // plan in the platform console). Disable fleet-wide with SAAS_AUTO_TRIAL=false.
  if (input.startTrial !== false && process.env.SAAS_AUTO_TRIAL !== "false" && resId) {
    try {
      await startTrialIfMissing(resId, Number(process.env.SAAS_TRIAL_DAYS || 14));
    } catch (e) {
      logger.warn({ err: e }, "start_trial_failed");
    }
  }

  return { res_id: resId, res_username: slug };
}
