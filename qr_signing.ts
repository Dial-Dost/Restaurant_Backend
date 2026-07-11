import { createHmac, timingSafeEqual } from "crypto";

// Tables in the customer QR URL are bound to an HMAC signature so a customer
// can't just edit ?table= and order/pay for a different table. The QR a table
// prints carries table + sig; the public /qr endpoints reject any mismatch.
//
// The secret comes from QR_SIGNING_SECRET (set per deployment in .env). It is the
// ONLY thing stopping a customer from forging a ?t=/sig for any table of any
// restaurant on the public /qr endpoints, so in production it MUST be set: we
// refuse to boot with the dev fallback. A fallback keeps local dev working.
const DEV_FALLBACK_SECRET = "restaurant-dash-dev-qr-secret";
const SECRET = process.env.QR_SIGNING_SECRET || DEV_FALLBACK_SECRET;
if (SECRET === DEV_FALLBACK_SECRET) {
  // The fallback is a source-published secret, so it is fail-closed by default
  // REGARDLESS of NODE_ENV — a deploy that simply forgot to set NODE_ENV=production
  // must NOT silently sign QR table tokens with a public key (cross-tenant forgery).
  // Local dev opts in explicitly with ALLOW_DEV_QR_SECRET=true (never in prod).
  const devOptIn = process.env.ALLOW_DEV_QR_SECRET === "true" && process.env.NODE_ENV !== "production";
  if (!devOptIn) {
    throw new Error(
      "QR_SIGNING_SECRET is not set. Refusing to start with the public dev fallback — set a strong " +
        "per-deployment QR_SIGNING_SECRET (openssl rand -base64 32). For local dev only, set ALLOW_DEV_QR_SECRET=true.",
    );
  }
  console.warn("[security] QR_SIGNING_SECRET unset — using the public DEV fallback (ALLOW_DEV_QR_SECRET). Never do this in production.");
}

function normalize(tableName: string): string {
  return tableName.trim().toLowerCase();
}

// Short, URL-safe signature (96 bits — infeasible to forge without the secret).
export function signTable(resId: string, tableName: string): string {
  return createHmac("sha256", SECRET)
    .update(`${resId}:${normalize(tableName)}`)
    .digest("base64url")
    .slice(0, 16);
}

export function verifyTable(resId: string, tableName: string, sig: string): boolean {
  if (!sig || !tableName || !resId) return false;
  const expected = signTable(resId, tableName);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// An opaque token carried in the customer QR URL as ?t=<token>. It bundles the
// (base64url-encoded) table name with its signature, so there is no plain table
// name in the URL to swap, and any edit fails to decode/verify.
export function encodeTableToken(resId: string, tableName: string): string {
  const name64 = Buffer.from(tableName.trim()).toString("base64url");
  return `${name64}.${signTable(resId, tableName)}`;
}

export function decodeTableToken(resId: string, token: string): string | null {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const name64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let tableName: string;
  try {
    tableName = Buffer.from(name64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!tableName) return null;
  return verifyTable(resId, tableName, sig) ? tableName : null;
}
