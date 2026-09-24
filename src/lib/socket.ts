import type { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { env } from '../config/env';
import { verifyToken } from './jwt';

export const roomNames = {
  team: (teamId: string) => `team:${teamId}`,
  user: (userId: string) => `user:${userId}`,
} as const;

let io: SocketServer | null = null;

export function initSocket(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    cors: {
      origin: env.frontendOrigins,
      methods: ['GET', 'POST'],
    },
  });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) return next(new Error('Unauthorized'));
      const payload = verifyToken(token);
      socket.data.userId = payload.userId;
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId as string;
    socket.join(roomNames.user(userId));
    console.log(`[socket] user connected: ${userId}`);
  });

  return io;
}

export function getIO(): SocketServer {
  if (!io) throw new Error('Socket.io belum di-init');
  return io;
}

export function emitToUser(userId: string, event: string, data: unknown) {
  try {
    getIO().to(roomNames.user(userId)).emit(event, data);
  } catch (err) {
    console.warn(`[socket] emitToUser failed for user ${userId}:`, err);
  }
}

export function emitToTeam(teamId: string, event: string, data: unknown) {
  try {
    getIO().to(roomNames.team(teamId)).emit(event, data);
  } catch (err) {
    console.warn(`[socket] emitToTeam failed for team ${teamId}:`, err);
  }
}
