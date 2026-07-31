// Web Push for guest queue notifications.
//
// Why: a walk-in who joined the queue puts their phone away. The "we're calling
// you" and "your table is ready" messages have to reach them with the browser
// CLOSED, which only the push service can do — a socket event or an open-tab poll
// cannot. The guest's browser gives us a push endpoint + two keys (stored by
// SavePushSubscription); this module signs a VAPID request to that endpoint.
//
// Configuration (env):
//   VAPID_PUBLIC_KEY   — public application server key; served to the browser so
//                        it can create a subscription. Not a secret.
//   VAPID_PRIVATE_KEY  — SECRET signing key. Never leaves the server.
//   VAPID_SUBJECT      — mailto: or https: URL identifying the sender
//                        (defaults to mailto:support@cuisineflow.app).
// With any of the keys missing, push is simply DISABLED: isPushConfigured() is
// false, the public key endpoint reports it, and sends become no-ops. Nothing in
// the queue flow depends on push succeeding.
import webpush from "web-push";
import { logger } from "./observability.js";

export interface PushTarget {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Relative or absolute URL the notification click should open. */
  url?: string;
  /** Collapse key — a newer message with the same tag replaces the older one. */
  tag?: string;
  data?: Record<string, unknown>;
}

/** Outcome per endpoint so the caller can prune dead subscriptions. */
export type PushOutcome = "sent" | "gone" | "failed" | "disabled";

const PUBLIC_KEY = String(process.env.VAPID_PUBLIC_KEY ?? "").trim();
const PRIVATE_KEY = String(process.env.VAPID_PRIVATE_KEY ?? "").trim();
const SUBJECT = String(process.env.VAPID_SUBJECT ?? "").trim() || "mailto:support@cuisineflow.app";

let configured = false;
if (PUBLIC_KEY && PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
    configured = true;
  } catch (err) {
    // A malformed key pair must not stop the server booting.
    logger.warn({ err: (err as any)?.message ?? err }, "web_push_vapid_invalid");
  }
}

export function isPushConfigured(): boolean {
  return configured;
}

/** The PUBLIC application server key the browser needs to subscribe (or ""). */
export function pushPublicKey(): string {
  return configured ? PUBLIC_KEY : "";
}

/**
 * Send one payload to one endpoint. NEVER throws — the caller is always on a
 * queue path where a push failure must be invisible to staff and to the guest.
 * A 404/410 from the push service means the subscription is dead ("gone").
 */
export async function sendPush(target: PushTarget, payload: PushPayload): Promise<PushOutcome> {
  if (!configured) {return "disabled";}
  try {
    await webpush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      JSON.stringify(payload),
      { TTL: 60 * 30 }, // a table-ready message is worthless after half an hour
    );
    return "sent";
  } catch (err) {
    const status = Number((err as any)?.statusCode ?? 0);
    if (status === 404 || status === 410) {return "gone";}
    logger.warn({ err: (err as any)?.message ?? err, status }, "web_push_send_failed");
    return "failed";
  }
}
