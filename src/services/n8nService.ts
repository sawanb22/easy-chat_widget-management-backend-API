import axios from 'axios';
import type { message_role } from '@prisma/client';
import logger from '../utils/logger';
import { env } from '../config/env';

export interface N8nHistoryEntry {
  sender: message_role;
  content: string;
  createdAt: string;
}

export interface N8nPayload {
  sessionId: string;
  message: string;
  history: N8nHistoryEntry[];
  metadata?: Record<string, unknown>;
}

export const sendToN8n = async (payload: N8nPayload): Promise<string> => {
  try {
    logger.info(`Sending message to n8n (session=${payload.sessionId})`);
    logger.info(`n8n URL: ${env.n8nWebhookUrl}`);
    logger.info(`Payload: ${JSON.stringify({ sessionId: payload.sessionId, chatInput: payload.message, historyLength: payload.history.length })}`);

    const response = await axios.post(
      env.n8nWebhookUrl,
      {
        sessionId: payload.sessionId,
        chatInput: payload.message,
        history: payload.history,
        metadata: payload.metadata ?? null,
      },
      { timeout: 60000 } // 60s timeout for long-running AI responses
    );

    const data = response.data;
    const output =
      data?.output ??
      data?.text ??
      data?.message ??
      (typeof data === 'string' ? data : JSON.stringify(data));

    return output;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(`Error connecting to n8n: ${errMsg}`);
    return "I'm having trouble connecting to my brain right now. Please try again shortly.";
  }
};