import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { env } from './config/env';
import { prisma } from './lib/prisma';
import { createSocketManager } from './services/socketManager';
import { startCleanupJob } from './services/cleanupJob';
import logger from './utils/logger';

const app = express();
const httpServer = createServer(app);

// ===================
// MIDDLEWARE
// ===================
app.use(cors({ 
    origin: env.corsOrigins.length ? env.corsOrigins : '*', 
    credentials: true 
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// ===================
// REST API ENDPOINTS
// ===================

// Health check
app.get('/health', (_req: Request, res: Response) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Get all sessions
app.get('/api/sessions', async (_req: Request, res: Response) => {
    try {
        const sessions = await prisma.chatSession.findMany({
            orderBy: { created_at: 'desc' },
            take: 50,
        });
        res.json(sessions);
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to fetch sessions: ${errMsg}`);
        res.status(500).json({ error: 'Failed to fetch sessions' });
    }
});

// Create new session
app.post('/api/sessions', async (req: Request, res: Response) => {
    try {
        const { metadata, visitorId } = req.body || {};
        const session = await prisma.chatSession.create({
            data: {
                visitor_id: visitorId || uuidv4(), // Generate if not provided
                metadata: metadata || {},
                status: 'ACTIVE',
                last_active_at: new Date(),
            },
        });
        logger.info(`New session created: ${session.id}`);
        res.status(201).json(session);
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        logger.error(`Failed to create session: ${errMsg}`);
        res.status(500).json({ error: 'Failed to create session', details: errMsg, stack });
    }
});

// Get single session by ID
app.get('/api/sessions/:id', async (req: Request, res: Response) => {
    try {
        const session = await prisma.chatSession.findUnique({
            where: { id: req.params.id },
            include: { chat_message: { orderBy: { created_at: 'asc' } } },
        });
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }
        res.json(session);
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to fetch session: ${errMsg}`);
        res.status(500).json({ error: 'Failed to fetch session' });
    }
});

// Get messages for a session
app.get('/api/sessions/:id/messages', async (req: Request, res: Response) => {
    try {
        const messages = await prisma.chatMessage.findMany({
            where: { session_id: req.params.id },
            orderBy: { created_at: 'asc' },
        });
        res.json(messages);
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to fetch messages: ${errMsg}`);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

// Send message to session (REST alternative to WebSocket)
app.post('/api/sessions/:id/messages', async (req: Request, res: Response) => {
    try {
        const { content } = req.body || {};
        if (!content) {
            return res.status(400).json({ error: 'Message content is required' });
        }

        // Check session exists
        const session = await prisma.chatSession.findUnique({
            where: { id: req.params.id },
        });
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        // Save user message
        const message = await prisma.chatMessage.create({
            data: {
                session_id: req.params.id,
                role: 'USER',
                content,
            },
        });

        // Update session activity
        await prisma.chatSession.update({
            where: { id: req.params.id },
            data: { last_active_at: new Date() },
        });

        logger.info(`Message saved for session ${req.params.id}`);
        res.status(201).json(message);
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to save message: ${errMsg}`);
        res.status(500).json({ error: 'Failed to save message' });
    }
});

// Heartbeat endpoint
app.patch('/api/sessions/:id/heartbeat', async (req: Request, res: Response) => {
    try {
        const session = await prisma.chatSession.update({
            where: { id: req.params.id },
            data: { last_active_at: new Date() },
        });
        res.json({ 
            id: session.id, 
            lastActiveAt: session.last_active_at,
            status: session.status 
        });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to update heartbeat: ${errMsg}`);
        res.status(500).json({ error: 'Failed to update heartbeat' });
    }
});

// Close session manually
app.patch('/api/sessions/:id/close', async (req: Request, res: Response) => {
    try {
        const session = await prisma.chatSession.update({
            where: { id: req.params.id },
            data: { status: 'CLOSED' },
        });
        logger.info(`Session ${req.params.id} closed manually`);
        res.json(session);
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to close session: ${errMsg}`);
        res.status(500).json({ error: 'Failed to close session' });
    }
});

// Debug: List all routes
app.get('/api/debug/routes', (_req: Request, res: Response) => {
    const routes: string[] = [];
    app._router.stack.forEach((middleware: any) => {
        if (middleware.route) {
            const methods = Object.keys(middleware.route.methods).join(', ').toUpperCase();
            routes.push(`${methods} ${middleware.route.path}`);
        }
    });
    res.json({ routes });
});

// ===================
// SOCKET.IO SETUP
// ===================
const io = createSocketManager(httpServer);

// ===================
// START SERVER
// ===================
startCleanupJob();

const PORT = env.port || 3001;

httpServer.listen(PORT, () => {
    logger.info(`🚀 Middleware Backend running on http://localhost:${PORT}`);
    logger.info(`📡 WebSocket ready for connections`);
    logger.info(`🔗 REST API endpoints:`);
    logger.info(`   GET    /health`);
    logger.info(`   GET    /api/sessions`);
    logger.info(`   POST   /api/sessions`);
    logger.info(`   GET    /api/sessions/:id`);
    logger.info(`   GET    /api/sessions/:id/messages`);
    logger.info(`   POST   /api/sessions/:id/messages`);
    logger.info(`   PATCH  /api/sessions/:id/heartbeat`);
    logger.info(`   PATCH  /api/sessions/:id/close`);
});

export { app, httpServer, io };
