import type { Server as HttpServer } from "http";
import { Server } from "socket.io";
import { createClient } from "redis";
import { createAdapter } from "@socket.io/redis-adapter";

export let io: Server | null = null;

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

  // Optional Redis adapter for multi-process scaling
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      const pubClient = createClient({ url: redisUrl });
      const subClient = pubClient.duplicate();
      await Promise.all([pubClient.connect(), subClient.connect()]);
      io.adapter(createAdapter(pubClient, subClient));
      console.log("Socket.IO redis adapter connected");
    } catch (err) {
      console.warn("Failed to initialize redis adapter for socket.io:", err);
    }
  }

  io.on("connection", (socket) => {
    const auth = socket.handshake.auth as any || {};
    const qs = socket.handshake.query as any || {};
    const restaurantId = auth.restaurantId ?? qs.restaurantId;

    // If client provided a restaurantId, join that room.
    if (restaurantId && typeof restaurantId === "string") {
      socket.join(`restaurant:${restaurantId}`);
    }

    socket.on("join", (rid: string) => {
      if (rid && typeof rid === "string") socket.join(`restaurant:${rid}`);
    });

    socket.on("leave", (rid: string) => {
      if (rid && typeof rid === "string") socket.leave(`restaurant:${rid}`);
    });

    // join a specific outlet room - payload: { restaurantId, outletId }
    socket.on("joinOutlet", (payload: any) => {
      try {
        if (!payload) return;
        const r = typeof payload.restaurantId === 'string' ? payload.restaurantId : null;
        const o = typeof payload.outletId === 'string' ? payload.outletId : null;
        if (r && o) socket.join(`restaurant:${r}:outlet:${o}`);
        // acknowledge join back to client for debugging/confirmation
        try {
          if (r && o) {
            socket.emit('joinedOutlet', { restaurantId: r, outletId: o });
            console.log(`Socket ${socket.id} joined restaurant:${r}:outlet:${o}`);
          }
        } catch (err) { }
      } catch (err) {
        // ignore
      }
    });

    socket.on("leaveOutlet", (payload: any) => {
      try {
        if (!payload) return;
        const r = typeof payload.restaurantId === 'string' ? payload.restaurantId : null;
        const o = typeof payload.outletId === 'string' ? payload.outletId : null;
        if (r && o) socket.leave(`restaurant:${r}:outlet:${o}`);
      } catch (err) { }
    });
  });

  console.log("Realtime Socket.IO initialized");
}

export function emitRestaurant(restaurantId: string, event: string, payload: unknown) {
  if (!io) return;
  try {
    const room = `restaurant:${restaurantId}`;
    console.log(`emitRestaurant -> ${room} event:${event} payload:`, payload);
    io.to(room).emit(event, payload);
    // log number of sockets in room for debugging
    try {
      io.in(room).allSockets().then(sockets => console.log(`emitRestaurant: ${sockets.size} socket(s) in ${room}`)).catch(() => { });
    } catch (e) { }
  } catch (err) {
    console.error("emitRestaurant failed", err);
  }
}

export function emitOutlet(restaurantId: string, outletId: string, event: string, payload: unknown) {
  if (!io) return;
  try {
    const room = `restaurant:${restaurantId}:outlet:${outletId}`;
    console.log(`emitOutlet -> ${room} event:${event}`); // payload:`, payload
    io.to(room).emit(event, payload);
    // log number of sockets in room for debugging
    try {
      io.in(room).allSockets().then(sockets => console.log(`emitOutlet: ${sockets.size} socket(s) in ${room}`)).catch(() => { });
    } catch (e) { }
  } catch (err) {
    console.error("emitOutlet failed", err);
  }
}

export function getIo() {
  return io;
}
