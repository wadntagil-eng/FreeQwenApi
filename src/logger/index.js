import winston from 'winston';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { LOG_LEVEL, LOG_MAX_SIZE, LOG_MAX_FILES, LOGS_DIR } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOG_DIR = path.resolve(__dirname, '..', '..', LOGS_DIR);
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

const { combine, timestamp, printf, colorize } = winston.format;

const consoleFormat = combine(
    colorize({ all: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    printf(({ level, message, timestamp }) => `${timestamp} [${level}]: ${message}`)
);

const fileFormat = combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    printf(({ level, message, timestamp }) => `${timestamp} [${level}]: ${message}`)
);


function sanitizeLogValue(value) {
    if (value === null || value === undefined) return '';

    let text;
    try {
        text = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
        text = String(value);
    }

    return text
        .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
        .replace(/(authorization["'\s:=]+)(Bearer\s+)?[^"'\s,}]+/gi, '$1[REDACTED]')
        .replace(/(cookie["'\s:=]+)[^"'\n]+/gi, '$1[REDACTED]')
        .replace(/(["']?(?:token|access_token|auth_token|security_token|access_key_secret|api[_-]?key)["']?\s*[:=]\s*["'])[^"']+(["'])/gi, '$1[REDACTED]$2')
        .replace(/(session(?:id)?["'\s:=]+)[^"'\s,}]+/gi, '$1[REDACTED]');
}

const customLevels = {
    levels: { error: 0, warn: 1, info: 2, http: 3, debug: 4, raw: 5 },
    colors: { error: 'red', warn: 'yellow', info: 'green', http: 'cyan', debug: 'blue', raw: 'magenta' }
};

const logger = winston.createLogger({
    levels: customLevels.levels,
    level: LOG_LEVEL,
    format: fileFormat,
    transports: [
        new winston.transports.File({
            filename: path.join(LOG_DIR, 'combined.log'),
            maxsize: LOG_MAX_SIZE,
            maxFiles: LOG_MAX_FILES
        }),
        new winston.transports.File({
            filename: path.join(LOG_DIR, 'http.log'),
            level: 'http',
            maxsize: LOG_MAX_SIZE,
            maxFiles: LOG_MAX_FILES
        }),
        new winston.transports.File({
            filename: path.join(LOG_DIR, 'error.log'),
            level: 'error',
            maxsize: LOG_MAX_SIZE,
            maxFiles: LOG_MAX_FILES
        }),
        new winston.transports.File({
            filename: path.join(LOG_DIR, 'raw-responses.log'),
            level: 'raw',
            maxsize: LOG_MAX_SIZE,
            maxFiles: LOG_MAX_FILES
        }),
        new winston.transports.Console({ format: consoleFormat })
    ]
});

winston.addColors(customLevels.colors);

const morganStream = {
    write: (message) => logger.http(sanitizeLogValue(message.trim()))
};

const morganFormat = ':remote-addr :method :url :status :res[content-length] - :response-time ms';
const httpLogger = morgan(morganFormat, { stream: morganStream });

export const logHttpRequest = httpLogger;
export const logInfo = (message) => logger.info(sanitizeLogValue(message));
export const logError = (message, error) => {
    if (error) {
        logger.error(sanitizeLogValue(`${message}: ${error.message}`));
        logger.error(sanitizeLogValue(error.stack));
    } else {
        logger.error(sanitizeLogValue(message));
    }
};
export const logWarn = (message) => logger.warn(sanitizeLogValue(message));
export const logDebug = (message) => logger.debug(sanitizeLogValue(message));
export const logRaw = (message) => logger.raw(sanitizeLogValue(message));
export const logHttp = (message) => logger.http(sanitizeLogValue(message));

export default { logHttpRequest, logInfo, logError, logWarn, logDebug, logRaw, logHttp };
