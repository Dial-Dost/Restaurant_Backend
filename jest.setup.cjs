// Runs before any test module is loaded (jest `setupFiles`).
// Pin a deterministic signing secret so qr_signing tests don't depend on the
// ambient shell and don't trip the "using DEV fallback" warning. The value is
// irrelevant to the assertions — they only check determinism and tenant binding.
process.env.QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || "jest-fixed-test-secret";
process.env.NODE_ENV = "test";
