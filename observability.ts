// Centralized observability: structured logging (pino), error tracking (Sentry),
// and Prometheus metrics. Sentry + metrics auth are OPT-IN via env vars, so this
// is a no-op cost in deployments that don't configure them.
import type { Request, Response, NextFunction } from "express";
import pino from "pino";
import client from "prom-client";
import * as Sentry from "@sentry/node";

// --- Structured logger -------------------------------------------------------
// JSON logs to stdout with leveled output and redaction so auth tokens / secrets
// never get written even if a caller logs a request or headers object.
export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "headers.authorization",
      "authorization",
      "password",
      "token",
      "key_secret",
      "*.password",
      "*.token",
      "*.authorization",
      // Report email (client item 9): recipient addresses never reach a log line.
      // The worker logs a short address tag instead; these catch an error object
      // or a transport result that carries the list anyway.
      "to",
      "recipients",
      "accepted",
      "rejected",
      "envelope",
      "*.to",
      "*.recipients",
      "*.accepted",
      "*.rejected",
      "*.envelope",
      "RESEND_API_KEY",
      "SMTP_PASS",
    ],
    censor: "[redacted]",
  },
});

// --- Sentry error tracking (no-op unless SENTRY_DSN is set) -------------------
let sentryEnabled = false;
export function initObservability(): void {
  const dsn = process.env.SENTRY_DSN;
  if (dsn) {
    try {
      Sentry.init({
        dsn,
        environment: process.env.NODE_ENV || "development",
        release: process.env.APP_VERSION || undefined,
        tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
      });
      sentryEnabled = true;
      logger.info("Sentry error tracking enabled");
    } catch (err) {
      logger.error({ err }, "Failed to initialize Sentry");
    }
  }
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!sentryEnabled) {return;}
  try {
    Sentry.captureException(err, context ? { extra: context } : undefined);
  } catch {
    /* never let error reporting throw */
  }
}

// --- Prometheus metrics ------------------------------------------------------
client.collectDefaultMetrics();
const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
});

// Records request latency by matched route pattern (keeps label cardinality low —
// e.g. /purchase-orders/:id, not one series per id).
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/metrics") {
    next();
    return;
  }
  const end = httpDuration.startTimer();
  res.on("finish", () => {
    const matched = (req.route && typeof req.route.path === "string") ? req.route.path : null;
    const route = matched ? `${req.baseUrl || ""}${matched}` : (req.baseUrl || "other");
    end({ method: req.method, route: route || "other", status: String(res.statusCode) });
  });
  next();
}

// GET /metrics handler. When METRICS_TOKEN is set it requires a matching bearer;
// otherwise it's open (restrict via network policy / Railway private networking).
export async function metricsHandler(req: Request, res: Response): Promise<void> {
  const token = process.env.METRICS_TOKEN;
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    res.status(401).end();
    return;
  }
  res.set("Content-Type", client.register.contentType);
  res.end(await client.register.metrics());
}
