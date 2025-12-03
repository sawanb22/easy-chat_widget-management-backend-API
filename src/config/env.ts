import 'dotenv/config';

type EnvSource = Record<string, string | undefined>;

const envSource: EnvSource = (
	(globalThis as typeof globalThis & { process?: { env: EnvSource } }).process?.env ?? {}
);

type EnvConfig = {
	port: number;
	corsOrigins: string[];
	n8nWebhookUrl: string;
	databaseUrl: string;
	apiSecret?: string;
	heartbeatTimeoutSeconds: number;
	sessionCloseMinutes: number;
};

function requireString(value: string | undefined, key: string): string {
	if (!value || !value.trim()) {
		throw new Error(`Missing required environment variable: ${key}`);
	}
	return value.trim();
}

function parseNumber(value: string | undefined, key: string, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number(value);
	if (Number.isNaN(parsed)) {
		throw new Error(`Environment variable ${key} must be a valid number`);
	}
	return parsed;
}

const rawOrigins: string = envSource.CORS_ORIGIN ?? '';
const corsOrigins = rawOrigins
	.split(',')
	.map((origin: string) => origin.trim())
	.filter(Boolean);

export const env: EnvConfig = {
	port: parseNumber(envSource.PORT, 'PORT', 3001),
	corsOrigins: corsOrigins.length ? corsOrigins : ['http://localhost:3000'],
	n8nWebhookUrl: requireString(envSource.N8N_WEBHOOK_URL, 'N8N_WEBHOOK_URL'),
	databaseUrl: requireString(envSource.DATABASE_URL, 'DATABASE_URL'),
	apiSecret: envSource.API_SECRET?.trim() || undefined,
	heartbeatTimeoutSeconds: parseNumber(
		envSource.HEARTBEAT_TIMEOUT_SECONDS,
		'HEARTBEAT_TIMEOUT_SECONDS',
		120
	),
	sessionCloseMinutes: parseNumber(envSource.SESSION_CLOSE_MINUTES, 'SESSION_CLOSE_MINUTES', 15),
};

export type { EnvConfig };
