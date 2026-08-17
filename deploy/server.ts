// Entrypoint for the always-on realtime task (ECS Fargate).
//
// It is `node build/index.js` with exactly one thing in front of it: the
// Secrets Manager fetch, which has to happen BEFORE index.ts is evaluated
// because that module reads its configuration at load time (see
// deploy/secrets.ts for the full reasoning).
//
// Everything after the dynamic import is the unmodified server: Express, the
// Socket.IO listener, the three in-process timers, the SIGTERM graceful
// shutdown. This file adds no behaviour of its own.
//
// Run it directly if you ever want to reproduce the Fargate task locally:
//   APP_SECRET_ARN=arn:aws:secretsmanager:... node build/deploy/server.js

import { loadSecretsIntoEnv } from "./secrets.js";

await loadSecretsIntoEnv();

// Dynamic, and after the await, on purpose: a static import would be hoisted
// above the secret load and index.ts would evaluate against an empty
// environment. Importing it for its side effects is the whole point — the
// module body builds the app and calls bootstrap() at index.ts:676.
await import("../index.js");
