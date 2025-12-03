import { schedule, ScheduledTask } from 'node-cron';
import { chat_session_status } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import logger from '../utils/logger';

export function startCleanupJob(): ScheduledTask {
	const heartbeatTimeoutSec = Number(env.heartbeatTimeoutSeconds);
	const sessionCloseMin = Number(env.sessionCloseMinutes);

	if (Number.isNaN(heartbeatTimeoutSec) || Number.isNaN(sessionCloseMin)) {
		logger.error('Invalid cleanup config: heartbeatTimeoutSeconds or sessionCloseMinutes is NaN', {
			heartbeatTimeoutSeconds: env.heartbeatTimeoutSeconds,
			sessionCloseMinutes: env.sessionCloseMinutes,
		});
		const noop = schedule('* * * * *', () => {});
		noop.stop();
		return noop;
	}

	return schedule('* * * * *', async () => {
		const now = Date.now();
		const inactiveThreshold = new Date(now - heartbeatTimeoutSec * 1000);
		const closeThreshold = new Date(now - sessionCloseMin * 60 * 1000);

		try {
			const inactiveResult = await prisma.chatSession.updateMany({
				where: {
					status: chat_session_status.ACTIVE,
					last_active_at: { lt: inactiveThreshold },
				},
				data: { status: chat_session_status.INACTIVE },
			});

			const closedResult = await prisma.chatSession.updateMany({
				where: {
					status: { in: [chat_session_status.ACTIVE, chat_session_status.INACTIVE] },
					last_active_at: { lt: closeThreshold },
				},
				data: { status: chat_session_status.CLOSED },
			});

			if (inactiveResult.count || closedResult.count) {
				logger.info(
					`Cleanup job: ${inactiveResult.count} inactive, ${closedResult.count} closed sessions`
				);
			}
		} catch (error) {
			const errMsg = error instanceof Error ? error.stack || error.message : String(error);
			logger.error(`Cleanup job failed: ${errMsg}`);
		}
	});
}
