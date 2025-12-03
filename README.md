# n8n Chat Middleware

Middleware "Body" that sits between the WordPress widget (Face) and n8n (Brain). It handles:

- Persistent chat sessions stored in Supabase/Postgres
- Real-time messaging via Socket.IO
- n8n orchestration + automatic session cleanup

## 1. Prerequisites

- Node.js 18+
- Supabase (or PostgreSQL) connection string
- n8n webhook URL capable of handling `{ sessionId, chatInput, history }`

## 2. Quick Start

```bash
cp .env.example .env # or edit current .env
npm install
npx prisma db push
npm run dev
```

Visit `http://localhost:3001/health` or drop the widget (`public/chat-widget.js`) into WordPress to verify connectivity.

## 3. Environment Variables

| Name | Description |
| --- | --- |
| `PORT` | HTTP/Socket server port (default `3001`) |
| `CORS_ORIGIN` | Comma-separated allowed origins for both HTTP + Socket.IO |
| `N8N_WEBHOOK_URL` | URL for your n8n webhook node |
| `DATABASE_URL` | Supabase/Postgres connection string |
| `API_SECRET` | Optional token for future protected routes |
| `HEARTBEAT_TIMEOUT_SECONDS` | Seconds of inactivity before marking session `INACTIVE` |
| `SESSION_CLOSE_MINUTES` | Minutes of inactivity before marking session `CLOSED` |

## 4. Database Schema

Defined in `prisma/schema.prisma`:

- `ChatSession` tracks visitor, status, timestamps, metadata
- `ChatMessage` stores ordered history with sender + payload snapshot

Run `npx prisma db push` to sync schema and `npx prisma studio` to inspect data.

## 5. Runtime Architecture

| File | Purpose |
| --- | --- |
| `src/server.ts` | Boots Express, Socket.IO, and the cleanup cron job |
| `src/services/socketManager.ts` | Manages connections, message flow, heartbeats |
| `src/services/n8nService.ts` | Axios client that talks to n8n (The Brain) |
| `src/services/cleanupJob.ts` | Cron job that marks sessions inactive/closed |
| `src/config/env.ts` | Centralized environment validation |
| `src/lib/prisma.ts` | Singleton Prisma client |
| `src/utils/logger.ts` | Winston-based structured logging |
| `public/chat-widget.js` | Drop-in widget for WordPress or any site |

## 6. Frontend Widget

Serve or copy `public/chat-widget.js` on your site. Required globals:

```html
<script>
	window.CHAT_MIDDLEWARE_URL = 'https://your-middleware-domain.com';
</script>
<script src="/path/to/chat-widget.js" defer></script>
```

The widget:

1. Loads Socket.IO client (CDN fallback included)
2. Persists `sessionId`/`visitorId` in `localStorage`
3. Sends heartbeats every 30 seconds
4. Emits `message` events and renders history from the middleware

## 7. Operational Notes

- Cleanup job runs every minute: >2 minutes inactivity ⇒ `INACTIVE`, >15 minutes ⇒ `CLOSED`
- `sendToN8n` forwards the last 50 messages to maintain conversational context
- Update `CORS_ORIGIN` + widget URL to your production domains before going live

## 8. Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start Express + Socket.IO via ts-node |
| `npm run build && npm start` | Compile to `dist/` then run with Node |
| `npm run prisma:push` | `prisma db push` shortcut |
| `npm run prisma:generate` | Regenerate Prisma client |

## 9. Next Steps

- Extend the API surface (REST endpoints, auth, transcripts)
- Trigger follow-up n8n workflows when sessions close
- Customize the widget UI/UX to match your brand
