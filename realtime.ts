import type { Server as HttpServer } from "http";
import { Server } from "socket.io";
import { createClient } from "redis";
import { createAdapter } from "@socket.io/redis-adapter";

export let io: Server | null = null;

export async function initRealtime(httpServer: HttpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: true,
      methods: ["GET", "POST"],
    },
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
  });

  console.log("Realtime Socket.IO initialized");
}

export function emitRestaurant(restaurantId: string, event: string, payload: unknown) {
  if (!io) return;
  try {
    io.to(`restaurant:${restaurantId}`).emit(event, payload);
  } catch (err) {
    console.error("emitRestaurant failed", err);
  }
}

export function getIo() {
  return io;
}
