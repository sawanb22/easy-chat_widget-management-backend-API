import type { Server as HttpServer } from 'http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { chat_session_status, message_role, Prisma } from '@prisma/client';
import { v4 as uuid } from 'uuid';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import logger from '../utils/logger';
import { sendToN8n, type N8nHistoryEntry } from './n8nService';

type ChatMessageDto = {
  id: string;
  sender: message_role;
  content: string;
  createdAt: string;
};

type IncomingMessagePayload = {
  sessionId?: string;
  content: string;
  metadata?: Record<string, unknown>;
};

type HeartbeatPayload = {
  sessionId?: string;
};

type EndSessionPayload = {
  sessionId?: string;
};

type ClientToServerEvents = {
  message: (payload: IncomingMessagePayload) => void;
  heartbeat: (payload: HeartbeatPayload) => void;
  endSession: (payload: EndSessionPayload) => void;
};

type ServerToClientEvents = {
  session: (payload: { sessionId: string; visitorId: string; status: chat_session_status }) => void;
  history: (payload: ChatMessageDto[]) => void;
  message: (payload: ChatMessageDto) => void;
  status: (payload: { status: chat_session_status }) => void;
  error: (payload: { message: string }) => void;
  sessionClosed: (payload: { sessionId: string; message: string }) => void;
};

type InterServerEvents = Record<string, never>;
type SocketData = {
  sessionId?: string;
  visitorId?: string;
};

export function createSocketManager(httpServer: HttpServer) {
  const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(
    httpServer,
    {
      cors: {
        origin: env.corsOrigins,
        credentials: true,
      },
    }
  );

  io.on('connection', (socket) => {
    // Debug: log ALL events from client
    socket.onAny((eventName, ...args) => {
      logger.info(`📥 [SERVER] Received event "${eventName}": ${JSON.stringify(args)}`);
    });
    
    void handleConnection(io, socket);
  });

  return io;
}

async function handleConnection(
  io: SocketIOServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>,
  socket: Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>
) {
  const visitorId =
    (socket.handshake.auth?.visitorId as string | undefined) ||
    (socket.handshake.query.visitorId as string | undefined) ||
    uuid();

  const requestedSessionId =
    (socket.handshake.auth?.sessionId as string | undefined) ||
    (socket.handshake.query.sessionId as string | undefined);

  try {
    const session = await ensureSession(visitorId, requestedSessionId);
    socket.data.sessionId = session.id;
    socket.data.visitorId = visitorId;
    socket.join(session.id);

    // IMPORTANT: Register event handlers BEFORE emitting session to avoid race condition
    // Client may immediately send 'message' after receiving 'session'
    registerSocketEvents(io, socket);
    logger.info(`Socket connected (visitor=${visitorId}, session=${session.id})`);

    // Now emit session info to client
    socket.emit('session', {
      sessionId: session.id,
      visitorId,
      status: session.status,
    });

    const history = await getHistory(session.id);
    if (history.length) {
      socket.emit('history', history);
    }

    await prisma.chatSession.update({
      where: { id: session.id },
      data: { last_active_at: new Date(), status: chat_session_status.ACTIVE },
    });
  } catch (error) {
    logger.error('Socket connection failed', error);
    socket.emit('error', { message: 'Unable to start chat session. Please refresh and try again.' });
    socket.disconnect(true);
  }
}

function registerSocketEvents(
  io: SocketIOServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>,
  socket: Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>
) {
  socket.on('message', async (payload) => {
    logger.info(`📥 [DEBUG] Message event received: ${JSON.stringify(payload)}`);
    const sessionId = payload.sessionId ?? socket.data.sessionId;
    logger.info(`📥 [DEBUG] Using sessionId: ${sessionId}`);
    if (!sessionId) {
      logger.warn('No sessionId available');
      socket.emit('error', { message: 'Session not established yet.' });
      return;
    }

    const content = payload.content?.trim();
    if (!content) {
      logger.warn('Empty content received');
      return;
    }
    logger.info(`📥 [DEBUG] Processing message for session ${sessionId}: "${content}"`);

    try {
      const session = await prisma.chatSession.findUnique({ where: { id: sessionId } });
      if (!session || session.status === chat_session_status.CLOSED) {
        socket.emit('status', { status: chat_session_status.CLOSED });
        return;
      }

      const userMessage = await prisma.chatMessage.create({
        data: {
          session_id: sessionId,
          role: message_role.USER,
          content,
        },
      });

      logger.info(`📤 [DEBUG] Emitting USER message to room ${sessionId}`);
      io.to(sessionId).emit('message', mapMessage(userMessage));
      logger.info(`📤 [DEBUG] USER message emitted`);

      await prisma.chatSession.update({
        where: { id: sessionId },
        data: { last_active_at: new Date(), status: chat_session_status.ACTIVE },
      });

      logger.info(`🤖 [DEBUG] Calling n8n webhook...`);
      const historyForBrain = await getHistory(sessionId, 50);
      const aiReply = await sendToN8n({
        sessionId,
        message: content,
        history: historyForBrain.map<N8nHistoryEntry>((m) => ({
          sender: m.sender,
          content: m.content,
          createdAt: m.createdAt,
        })),
        metadata: payload.metadata,
      });
      logger.info(`🤖 [DEBUG] n8n response received: "${aiReply.substring(0, 100)}..."`);

      const aiMessage = await prisma.chatMessage.create({
        data: {
          session_id: sessionId,
          role: message_role.BOT,
          content: aiReply,
        },
      });

      logger.info(`📤 [DEBUG] Emitting BOT message to room ${sessionId}`);
      io.to(sessionId).emit('message', mapMessage(aiMessage));
      logger.info(`📤 [DEBUG] BOT message emitted successfully`);
    } catch (error) {
      logger.error('Error handling message event', error);
      socket.emit('error', { message: 'Unable to send message right now. Please try again.' });
    }
  });

  socket.on('heartbeat', async (payload) => {
    const sessionId = payload.sessionId ?? socket.data.sessionId;
    if (!sessionId) return;

    try {
      await prisma.chatSession.update({
        where: { id: sessionId },
        data: { last_active_at: new Date(), status: chat_session_status.ACTIVE },
      });
    } catch (error) {
      logger.warn('Failed to record heartbeat', error as Error);
    }
  });

  // NEW: Handle end session request from client
  socket.on('endSession', async (payload) => {
    const sessionId = payload.sessionId ?? socket.data.sessionId;
    if (!sessionId) {
      logger.warn('endSession called but no sessionId available');
      return;
    }

    try {
      logger.info(`Ending session ${sessionId} by user request`);

      // 1. Mark session as CLOSED in database
      await prisma.chatSession.update({
        where: { id: sessionId },
        data: { 
          status: chat_session_status.CLOSED,
          last_active_at: new Date()
        },
      });

      // 2. Add a system message to mark the end
      await prisma.chatMessage.create({
        data: {
          session_id: sessionId,
          role: message_role.SYSTEM,
          content: 'Chat session ended by user.',
        },
      });

      // 3. Emit confirmation to the client
      socket.emit('sessionClosed', {
        sessionId,
        message: 'Session ended successfully. You can start a new conversation.',
      });

      // 4. Leave the room and clear socket data
      socket.leave(sessionId);
      socket.data.sessionId = undefined;

      logger.info(`Session ${sessionId} closed successfully`);

    } catch (error) {
      logger.error('Error ending session', error);
      socket.emit('error', { message: 'Failed to end session. Please try again.' });
    }
  });
}

async function ensureSession(visitorId: string, requestedSessionId?: string) {
  if (requestedSessionId) {
    const session = await prisma.chatSession.findUnique({ where: { id: requestedSessionId } });
    // Only reuse if session exists AND is not closed
    if (session && session.status !== chat_session_status.CLOSED) {
      return session;
    }
  }

  const existing = await prisma.chatSession.findFirst({
    where: {
      visitor_id: visitorId,
      status: { not: chat_session_status.CLOSED },
    },
    orderBy: { created_at: 'desc' },
  });

  if (existing) {
    return existing;
  }

  return prisma.chatSession.create({
    data: {
      visitor_id: visitorId,
      status: chat_session_status.ACTIVE,
    },
  });
}

async function getHistory(sessionId: string, limit = 100): Promise<ChatMessageDto[]> {
  const messages = await prisma.chatMessage.findMany({
    where: { session_id: sessionId },
    orderBy: { created_at: 'asc' },
    take: limit,
  });

  return messages.map(mapMessage);
}

function mapMessage(message: { id: string; role: message_role; content: string; created_at: Date }): ChatMessageDto {
  return {
    id: message.id,
    sender: message.role,
    content: message.content,
    createdAt: message.created_at.toISOString(),
  };
}
