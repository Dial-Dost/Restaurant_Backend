import type { Server as HttpServer } from "http";
import { Server } from "socket.io";
import { createClient } from "redis";
import { createAdapter } from "@socket.io/redis-adapter";
import { getSession } from "./auth/sessions.js";
import { logger } from "./observability.js";
import { resumeJitterMs, resumePrintJobsForAgent } from "./print_jobs.js";

export let io: Server | null = null;

// Whether the Redis pub/sub adapter is wired. When false on a multi-replica
// deployment, realtime events (bill:print, KDS, orders) only reach clients on the
// same replica. Surfaced in /health so the degradation isn't silent.
let adapterReady = false;
export function realtimeAdapterReady(): boolean {
  return adapterReady;
}

export async function initRealtime(httpServer: HttpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        // Allow all origins in development and production
        callback(null, true);
      },
      methods: ["GET", "POST", "OPTIONS"],
      credentials: true,
    },
    transports: ["websocket", "polling"],
    pingInterval: 30000,
    pingTimeout: 60000,
  });

  // Redis adapter for multi-process scaling. Required in production for realtime
  // to reach clients across replicas; without it, events stay on one replica.
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      const pubClient = createClient({ url: redisUrl });
      const subClient = pubClient.duplicate();
      // node-redis emits 'error' on connection drops; without a listener that can
      // crash the process. Log and let node-redis auto-reconnect.
      pubClient.on("error", (err) => { logger.error({ err }, "socketio_redis_pub_error"); });
      subClient.on("error", (err) => { logger.error({ err }, "socketio_redis_sub_error"); });
      await Promise.all([pubClient.connect(), subClient.connect()]);
      io.adapter(createAdapter(pubClient, subClient));
      adapterReady = true;
      logger.info("Socket.IO redis adapter connected");
    } catch (err) {
      adapterReady = false;
      logger.error({ err }, "Failed to initialize redis adapter for socket.io:");
      if (process.env.NODE_ENV === "production") {
        logger.error(
          "WARNING: running in production WITHOUT a socket.io Redis adapter — realtime " +
            "events will not reach clients on other replicas.",
        );
      }
    }
  } else if (process.env.NODE_ENV === "production") {
    logger.warn(
      "REDIS_URL not set — socket.io has no Redis adapter; realtime is single-replica only.",
    );
  }

  io.on("connection", async (socket) => {
    // Derive the tenant from the verified session token, never from a
    // client-supplied restaurantId — otherwise a client could subscribe to
    // another restaurant's realtime events.
    const auth = socket.handshake.auth as any || {};
    const token = typeof auth.token === "string" ? auth.token : null;
    let session = null;
    if (token) {
      try {
        session = await getSession(token);
      } catch (err) {
        logger.error({ err }, "socket_session_lookup_failed");
      }
    }

    if (!session) {
      // Connect but join no tenant rooms and ignore join requests, so an
      // unauthenticated socket never receives any restaurant's events.
      logger.warn({ socketId: socket.id }, "socket connected without a valid session; no rooms joined");
      return;
    }

    // Captured as consts because the joinOutlet closure below outlives this
    // scope's narrowing of `session` (a `let`, so TypeScript re-widens it inside a
    // nested function).
    const resId = session.res_id;
    const employeeId = session.employeeId;
    const role = session.role;
    socket.join(`restaurant:${resId}`);

    // All room operations are pinned to the caller's own restaurant.
    socket.on("join", (rid: string) => {
      if (rid === resId) {socket.join(`restaurant:${resId}`);}
    });

    socket.on("leave", (rid: string) => {
      if (rid === resId) {socket.leave(`restaurant:${resId}`);}
    });

    // THE RECONNECT HOOK. The printer agent re-emits joinOutlet on every connect
    // AND every reconnect, so this is already the exact moment a till comes back —
    // no new client-side trigger had to be invented for replay.
    socket.on("joinOutlet", (payload: any) => {
      const o = payload && typeof payload.outletId === 'string' ? payload.outletId : null;
      // ADDITIVE and optional. A build that predates durable printing sends no
      // version and is never replayed to (resumePrintJobsForAgent's interlock):
      // it has no per-job dedup and no way to ack, so replaying to it would
      // reprint the outstanding backlog on every socket flap, forever.
      const rawVersion = payload && typeof payload.agentVersion === 'string' ? payload.agentVersion.trim() : "";
      const agentVersion = rawVersion.length > 0 ? rawVersion : null;
      if (o) {
        socket.join(`restaurant:${resId}:outlet:${o}`);
        socket.emit('joinedOutlet', { restaurantId: resId, outletId: o });
        logger.info(`Socket ${socket.id} joined restaurant:${resId}:outlet:${o}`);
        // Deliberately NOT awaited and deliberately jittered. The room join must
        // be immediate (live printing depends on it) and a fleet-wide reconnect
        // must not turn into a fleet-wide simultaneous query. Errors are swallowed
        // inside resumePrintJobsForAgent; the catch here only covers a scheduling
        // failure so an unhandled rejection can never take the process down.
        const timer = setTimeout(() => {
          void resumePrintJobsForAgent({
            resId,
            outletId: o,
            // socket.id is stable for this connection and changes on reconnect,
            // which is exactly the identity a lease wants: diagnostic in
            // claimed_by, and never reused by a socket that has gone away.
            agentId: socket.id,
            agentVersion,
            employeeId,
            role,
            deliver: (p) => { socket.emit('bill:print', p); },
          }).catch((err: unknown) => { logger.error({ err }, "print_resume_dispatch_failed"); });
        }, resumeJitterMs());
        timer.unref?.();
      }
    });

    socket.on("leaveOutlet", (payload: any) => {
      const o = payload && typeof payload.outletId === 'string' ? payload.outletId : null;
      if (o) {socket.leave(`restaurant:${resId}:outlet:${o}`);}
    });
  });

  logger.info("Realtime Socket.IO initialized");
}

export function emitRestaurant(restaurantId: string, event: string, payload: unknown) {
  if (!io) {return;}
  try {
    const room = `restaurant:${restaurantId}`;
    // Don't log the payload (may contain customer/bill data); event name only.
    io.to(room).emit(event, payload);
  } catch (err) {
    logger.error({ err }, "emitRestaurant failed");
  }
}

export function emitOutlet(restaurantId: string, outletId: string, event: string, payload: unknown) {
  if (!io) {return;}
  try {
    const room = `restaurant:${restaurantId}:outlet:${outletId}`;
    io.to(room).emit(event, payload);
  } catch (err) {
    logger.error({ err }, "emitOutlet failed");
  }
}

export function getIo() {
  return io;
}

// Close socket.io (and its underlying connections) for graceful shutdown.
export async function closeRealtime(): Promise<void> {
  if (!io) {return;}
  await new Promise<void>((resolve) => io!.close(() => { resolve(); }));
}
