// Print a fresh VAPID key pair for Web Push (guest queue notifications).
//
// Usage:
//   npm run push:vapid-keys
//
// Deliberately PRINTS ONLY — it never writes to .env, so running it can never
// commit a real key or clobber the pair a deployed environment is already using.
// Copy the two lines it prints into your own .env (see the "Web Push" block in
// .env.example), then restart the backend: GET /qr/:slug/push/key will start
// reporting enabled:true.
//
// Rotating the pair invalidates every stored PushSubscription — browsers were
// issued their endpoint against the OLD public key and must subscribe again.
import webpush from "web-push";

const existingPublic = String(process.env.VAPID_PUBLIC_KEY ?? "").trim();
const existingPrivate = String(process.env.VAPID_PRIVATE_KEY ?? "").trim();

if (existingPublic && existingPrivate) {
  console.log("VAPID keys are ALREADY configured in this environment.");
  console.log(`  VAPID_PUBLIC_KEY=${existingPublic}`);
  console.log("  VAPID_PRIVATE_KEY=*** (set, not printed)");
  console.log("");
  console.log("Generating a NEW pair below would invalidate every existing browser");
  console.log("subscription. Only replace them if you intend to rotate.");
  console.log("");
}

const keys = webpush.generateVAPIDKeys();
console.log("# --- Web Push (paste into .env; the private key is a SECRET) ---");
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log(`VAPID_SUBJECT=${String(process.env.VAPID_SUBJECT ?? "").trim() || "mailto:support@cuisineflow.app"}`);
