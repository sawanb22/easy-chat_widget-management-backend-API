import winston from 'winston';

const isProd = process.env.NODE_ENV === 'production';

const consoleFormat = isProd
  ? winston.format.combine(winston.format.timestamp(), winston.format.json())
  : winston.format.combine(winston.format.colorize(), winston.format.simple());

const consoleTransport = new winston.transports.Console({
  format: consoleFormat,
  stderrLevels: ['error'],
});

const logger = winston.createLogger({
  level: 'info',
  transports: [consoleTransport],
});

export default logger;