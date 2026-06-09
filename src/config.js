import dns from 'dns/promises';
import net from 'net';

// config.js — Единый источник конфигурации проекта.
// Все значения читаются из env-переменных с фоллбэками на дефолты.

function toBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value !== 'string') return false;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function isPrivateHostname(hostname) {
    const normalized = hostname.toLowerCase().replace(/[\[\]]/g, '');

    if (['localhost', '0', '0.0.0.0', '::', '::1'].includes(normalized)) return true;
    if (normalized.endsWith('.localhost') || normalized.endsWith('.local')) return true;

    if (net.isIPv4(normalized)) {
        const [a, b] = normalized.split('.').map(Number);
        return a === 10 ||
            a === 127 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168);
    }

    if (net.isIPv6(normalized)) {
        return normalized === '::' || normalized === '::1' ||
            normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
    }

    return false;
}

function assertSafeUpstreamUrl(value, name) {
    const url = new URL(value);
    if (url.protocol !== 'https:') {
        throw new Error(`${name} должен использовать https://`);
    }
    if (!toBoolean(process.env.ALLOW_PRIVATE_UPSTREAMS) && isPrivateHostname(url.hostname)) {
        throw new Error(`${name} указывает на локальный или приватный хост: ${url.hostname}`);
    }
    return value;
}

// ─── API URLs ────────────────────────────────────────────────────────────────
const QWEN_BASE_URL = assertSafeUpstreamUrl(process.env.QWEN_BASE_URL || 'https://chat.qwen.ai', 'QWEN_BASE_URL');

export const CHAT_API_URL = assertSafeUpstreamUrl(process.env.CHAT_API_URL || `${QWEN_BASE_URL}/api/v2/chat/completions`, 'CHAT_API_URL');
export const CREATE_CHAT_URL = assertSafeUpstreamUrl(process.env.CREATE_CHAT_URL || `${QWEN_BASE_URL}/api/v2/chats/new`, 'CREATE_CHAT_URL');
export const CHAT_PAGE_URL = assertSafeUpstreamUrl(process.env.CHAT_PAGE_URL || `${QWEN_BASE_URL}/`, 'CHAT_PAGE_URL');
export const TASK_STATUS_URL = assertSafeUpstreamUrl(process.env.TASK_STATUS_URL || `${QWEN_BASE_URL}/api/v1/tasks/status`, 'TASK_STATUS_URL');
export const STS_TOKEN_API_URL = assertSafeUpstreamUrl(process.env.STS_TOKEN_API_URL || `${QWEN_BASE_URL}/api/v1/files/getstsToken`, 'STS_TOKEN_API_URL');
export const AUTH_SIGNIN_URL = assertSafeUpstreamUrl(process.env.AUTH_SIGNIN_URL || `${QWEN_BASE_URL}/auth?action=signin`, 'AUTH_SIGNIN_URL');
export const OSS_SDK_URL = assertSafeUpstreamUrl(process.env.OSS_SDK_URL || 'https://gosspublic.alicdn.com/aliyun-oss-sdk-6.20.0.min.js', 'OSS_SDK_URL');

const UPSTREAM_URLS = [
    ['QWEN_BASE_URL', QWEN_BASE_URL],
    ['CHAT_API_URL', CHAT_API_URL],
    ['CREATE_CHAT_URL', CREATE_CHAT_URL],
    ['CHAT_PAGE_URL', CHAT_PAGE_URL],
    ['TASK_STATUS_URL', TASK_STATUS_URL],
    ['STS_TOKEN_API_URL', STS_TOKEN_API_URL],
    ['AUTH_SIGNIN_URL', AUTH_SIGNIN_URL],
    ['OSS_SDK_URL', OSS_SDK_URL]
];

export async function validateUpstreamDns() {
    if (toBoolean(process.env.ALLOW_PRIVATE_UPSTREAMS)) return;

    const checkedHosts = new Set();
    for (const [name, value] of UPSTREAM_URLS) {
        const { hostname } = new URL(value);
        if (checkedHosts.has(hostname)) continue;
        checkedHosts.add(hostname);

        const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
        for (const address of addresses) {
            if (isPrivateHostname(address.address)) {
                throw new Error(`${name} DNS resolved ${hostname} to private address ${address.address}`);
            }
        }
    }
}

// ─── Таймауты (мс) ──────────────────────────────────────────────────────────
export const PAGE_TIMEOUT = Number(process.env.PAGE_TIMEOUT) || 120_000;
export const AUTH_TIMEOUT = Number(process.env.AUTH_TIMEOUT) || 120_000;
export const NAVIGATION_TIMEOUT = Number(process.env.NAVIGATION_TIMEOUT) || 60_000;
export const RETRY_DELAY = Number(process.env.RETRY_DELAY) || 2_000;
export const STREAMING_CHUNK_DELAY = Number(process.env.STREAMING_CHUNK_DELAY) || 20;

// ─── Лимиты ─────────────────────────────────────────────────────────────────
export const PAGE_POOL_SIZE = Number(process.env.PAGE_POOL_SIZE) || 3;
export const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024; // 10 MB
export const MAX_HISTORY_LENGTH = Number(process.env.MAX_HISTORY_LENGTH) || 100;
export const MAX_RETRY_COUNT = Number(process.env.MAX_RETRY_COUNT) || 3;
export const TASK_POLL_MAX_ATTEMPTS = Number(process.env.TASK_POLL_MAX_ATTEMPTS) || 90;
export const TASK_POLL_INTERVAL = Number(process.env.TASK_POLL_INTERVAL) || 2_000;
export const MAX_JSON_BODY_SIZE = process.env.MAX_JSON_BODY_SIZE || '10mb';
export const MAX_REQUEST_MESSAGES = Number(process.env.MAX_REQUEST_MESSAGES) || 100;
export const MAX_REQUEST_TEXT_CHARS = Number(process.env.MAX_REQUEST_TEXT_CHARS) || 1_000_000;

// ─── Безопасность входящих запросов ─────────────────────────────────────────
export const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
export const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 120;
export const RATE_LIMIT_AUTH_MAX_REQUESTS = Number(process.env.RATE_LIMIT_AUTH_MAX_REQUESTS) || 600;

// ─── Пути (относительно корня проекта) ───────────────────────────────────────
export const SESSION_DIR = process.env.SESSION_DIR || 'session';
export const ACCOUNTS_DIR = 'accounts';
export const UPLOADS_DIR = process.env.UPLOADS_DIR || 'uploads';
export const LOGS_DIR = process.env.LOGS_DIR || 'logs';

// ─── Браузер ─────────────────────────────────────────────────────────────────
export const VIEWPORT_WIDTH = Number(process.env.VIEWPORT_WIDTH) || 1920;
export const VIEWPORT_HEIGHT = Number(process.env.VIEWPORT_HEIGHT) || 1080;
export const USER_AGENT = process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ─── Сервер ──────────────────────────────────────────────────────────────────
export const PORT = Number(process.env.PORT) || 3264;
export const HOST = process.env.HOST || '0.0.0.0';
export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'qwen-max-latest';
export const ALLOW_UNSCOPED_SESSION_CHAT_RESTORE = toBoolean(process.env.ALLOW_UNSCOPED_SESSION_CHAT_RESTORE);

// ─── Логирование ─────────────────────────────────────────────────────────────
export const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
export const LOG_MAX_SIZE = Number(process.env.LOG_MAX_SIZE) || 5_242_880; // 5 MB
export const LOG_MAX_FILES = Number(process.env.LOG_MAX_FILES) || 5;
