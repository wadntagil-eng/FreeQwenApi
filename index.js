import express from 'express';
import bodyParser from 'body-parser';
import crypto from 'crypto';

import { initBrowser, shutdownBrowser } from './src/browser/browser.js';
import apiRoutes from './src/api/routes.js';
import { getAvailableModelsFromFile, getApiKeys } from './src/api/chat.js';
import { loadTokens } from './src/api/tokenManager.js';
import { addAccountInteractive } from './src/utils/accountSetup.js';
import { logHttpRequest, logInfo, logError, logWarn } from './src/logger/index.js';
import { prompt } from './src/utils/prompt.js';
import { FORGETMEAI_WATERMARK } from './src/utils/branding.js';
import {
    PORT, HOST, ALLOWED_ORIGINS, MAX_JSON_BODY_SIZE,
    RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_AUTH_MAX_REQUESTS,
    validateUpstreamDns
} from './src/config.js';

const app = express();
if (toBoolean(process.env.TRUST_PROXY)) app.set('trust proxy', true);

const port = Number.parseInt(process.env.PORT ?? PORT, 10);
const host = process.env.HOST || HOST;

if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`Некорректное значение переменной PORT: ${process.env.PORT}`);
}

function toBoolean(value) {
    if (typeof value !== 'string') return false;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

const skipAccountMenu = toBoolean(process.env.SKIP_ACCOUNT_MENU) || toBoolean(process.env.NON_INTERACTIVE);

const rateLimitBuckets = new Map();

function getRateLimitKey(req) {
    const authHeader = req.get('Authorization') || '';
    if (authHeader.startsWith('Bearer ')) {
        return `auth:${crypto.createHash('sha256').update(authHeader.substring(7).trim()).digest('hex')}`;
    }

    return `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
}

function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    const hasBearerToken = (req.get('Authorization') || '').startsWith('Bearer ');
    const maxRequests = hasBearerToken ? RATE_LIMIT_AUTH_MAX_REQUESTS : RATE_LIMIT_MAX_REQUESTS;
    const windowMs = RATE_LIMIT_WINDOW_MS;
    const key = getRateLimitKey(req);
    const bucket = rateLimitBuckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
        rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
        return next();
    }

    bucket.count += 1;
    if (bucket.count > maxRequests) {
        const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
        res.header('Retry-After', String(retryAfter));
        return res.status(429).json({ error: 'Слишком много запросов', retryAfter });
    }

    return next();
}

setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of rateLimitBuckets.entries()) {
        if (bucket.resetAt <= now) rateLimitBuckets.delete(key);
    }
}, RATE_LIMIT_WINDOW_MS).unref();

async function upstreamDnsGuardMiddleware(req, res, next) {
    try {
        await validateUpstreamDns();
        return next();
    } catch (error) {
        logError('Проверка DNS upstream URL не пройдена', error);
        return res.status(502).json({ error: 'Upstream URL failed DNS safety check' });
    }
}

function ensureNonInteractiveTokens() {
    const tokens = loadTokens();
    if (!tokens.length) {
        logError('Не найдено ни одного аккаунта. Запустите скрипт авторизации перед запуском сервера.');
        process.exit(1);
    }
    const now = Date.now();
    const validTokens = tokens.filter(t => (!t.resetAt || new Date(t.resetAt).getTime() <= now) && !t.invalid);
    if (!validTokens.length) {
        logError('Все аккаунты недоступны. Перезапустите авторизацию перед запуском сервера.');
        process.exit(1);
    }
    logInfo(`Автоматический запуск: обнаружено ${tokens.length} аккаунтов, из них ${validTokens.length} активны.`);
}

app.use(logHttpRequest);
app.use(bodyParser.json({ limit: MAX_JSON_BODY_SIZE }));
app.use(bodyParser.urlencoded({ limit: MAX_JSON_BODY_SIZE, extended: true }));

app.use((err, req, res, next) => {
    const isJsonSyntaxError = err instanceof SyntaxError && err.status === 400 && Object.prototype.hasOwnProperty.call(err, 'body');

    if (isJsonSyntaxError) {
        logWarn(`Некорректный JSON в запросе: ${err.message}`);
        return res.status(400).json({
            error: 'Некорректный JSON',
            message: 'Проверьте тело запроса: используйте валидный JSON с двойными кавычками.'
        });
    }

    if (err?.type === 'entity.too.large' || err?.status === 413) {
        logWarn(`Тело запроса слишком большое: ${err.message}`);
        return res.status(413).json({ error: 'Тело запроса слишком большое' });
    }

    return next(err);
});

app.use((req, res, next) => {
    const requestOrigin = req.get('Origin');
    const allowsWildcard = ALLOWED_ORIGINS.includes('*');
    const allowedOrigin = allowsWildcard ? '*' : ALLOWED_ORIGINS.find(origin => origin === requestOrigin);

    if (allowedOrigin) {
        res.header('Access-Control-Allow-Origin', allowedOrigin);
        if (!allowsWildcard) res.header('Vary', 'Origin');
    }

    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(allowedOrigin ? 204 : 403);
    next();
});

app.use('/api', rateLimitMiddleware, upstreamDnsGuardMiddleware, apiRoutes);

app.use((req, res) => {
    logWarn(`404 Not Found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ error: 'Эндпоинт не найден' });
});

app.use((err, req, res, next) => {
    logError('Внутренняя ошибка сервера', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
process.on('SIGHUP', handleShutdown);
process.on('uncaughtException', async (error) => {
    logError('Необработанное исключение', error);
    await handleShutdown();
});

async function handleShutdown() {
    logInfo('\nПолучен сигнал завершения. Закрываем браузер...');
    await shutdownBrowser();
    logInfo('Завершение работы.');
    process.exit(0);
}

async function startServer() {
    console.log(`
███████ ██████  ███████ ███████  ██████  ██     ██ ███████ ███    ██  █████  ██████  ██ 
██      ██   ██ ██      ██      ██    ██ ██     ██ ██      ████   ██ ██   ██ ██   ██ ██ 
█████   ██████  █████   █████   ██    ██ ██  █  ██ █████   ██ ██  ██ ███████ ██████  ██ 
██      ██   ██ ██      ██      ██ ▄▄ ██ ██ ███ ██ ██      ██  ██ ██ ██   ██ ██      ██ 
██      ██   ██ ███████ ███████  ██████   ███ ███  ███████ ██   ████ ██   ██ ██      ██ 
                                    ▀▀                                                    
   API-прокси для Qwen
   ${FORGETMEAI_WATERMARK}
`);

    logInfo('Запуск сервера...');

    if (!skipAccountMenu) {
        while (true) {
            const tokens = loadTokens();
            console.log('\nСписок аккаунтов:');
            if (!tokens.length) {
                console.log('  (пусто)');
            } else {
                tokens.forEach((token, i) => {
                    const now = Date.now();
                    const isInvalid = token.invalid === true;
                    const isWaiting = Boolean(token.resetAt && new Date(token.resetAt).getTime() > now);
                    const statusLabel = isInvalid ? '❌ Недействителен' : isWaiting ? '⏳ Ожидание сброса' : '✅ OK';
                    const statusCode = isInvalid ? 0 : isWaiting ? 1 : 2;
                    console.log(`${String(i + 1).padStart(2, ' ')} | ${token.id} | ${statusLabel} (${statusCode})`);
                });
            }
            console.log('\n=== Меню ===');
            console.log(`ForgetMeAI: ${FORGETMEAI_WATERMARK}`);
            console.log('1 - Добавить новый аккаунт');
            console.log('2 - Перелогинить аккаунт с истекшим токеном');
            console.log('3 - Запустить прокси (по умолчанию)');
            console.log('4 - Удалить аккаунт');

            let choice = await prompt('Ваш выбор (Enter = 3): ');
            if (!choice) choice = '3';

            if (choice === '1') {
                await addAccountInteractive();
            } else if (choice === '2') {
                const { reloginAccountInteractive } = await import('./src/utils/accountSetup.js');
                await reloginAccountInteractive();
            } else if (choice === '3') {
                const hasValidToken = tokens.some(t => {
                    if (t.invalid) return false;
                    if (!t.resetAt) return true;
                    return new Date(t.resetAt).getTime() <= Date.now();
                });
                if (!tokens.length || !hasValidToken) {
                    console.log('Нужен хотя бы один валидный аккаунт для запуска.');
                    continue;
                }
                break;
            } else if (choice === '4') {
                const { removeAccountInteractive } = await import('./src/utils/accountSetup.js');
                await removeAccountInteractive();
            }
        }
    } else {
        ensureNonInteractiveTokens();
    }

    const browserInitialized = await initBrowser(false);
    if (!browserInitialized) {
        logError('Не удалось инициализировать браузер. Завершение работы.');
        process.exit(1);
    }

    try {
        app.listen(port, host, () => {
            const displayHost = host === '0.0.0.0' ? 'localhost' : host;
            logInfo(`Сервер запущен на ${host}:${port}`);
            logInfo(`API доступен по адресу: http://${displayHost}:${port}/api`);
            logInfo('Для проверки статуса авторизации: GET /api/status');
            logInfo('Для отправки сообщения: POST /api/chat');
            logInfo('Для получения списка моделей: GET /api/models');
            logInfo('======================================================');
            logInfo('API v2 - История чатов хранится на серверах Qwen');
            logInfo('Создать новый чат: POST /api/chats');
            logInfo('Отправить сообщение: POST /api/chat (с chatId и parentId)');
            logInfo('======================================================');
            logInfo('Доступно 25 моделей Qwen (через систему маппинга):');
            logInfo('- Стандартные: qwen-max, qwen-plus, qwen-turbo и их latest-версии');
            logInfo('- Coder: qwen3-coder-plus, qwen2.5-coder-*b-instruct (0.5b - 32b)');
            logInfo('- Визуальные: qwen-vl-max, qwen-vl-plus и их latest-версии');
            logInfo('- Qwen 3: qwen3, qwen3-max, qwen3-plus, qwen3-omni-flash');
            logInfo('- Qwen 3.5: qwen3.5-plus, qwen3.5-flash, qwen3.5-397b-a17b, qwen3.5-122b-a10b, qwen3.5-27b, qwen3.5-35b-a3b');
            logInfo('======================================================');
            logInfo('Формат JSON запроса на чат:');
            logInfo('{ "message": "текст сообщения", "model": "название модели (опционально)", "chatId": "ID чата (опционально)", "parentId": "ID родительского сообщения (опционально)" }');
            logInfo('Пример первого запроса: { "message": "Привет, как дела?" }');
            logInfo('Пример второго запроса: { "message": "А что ты умеешь?", "chatId": "полученный_id_чата", "parentId": "полученный_parentId" }');
            logInfo('======================================================');
            logInfo('Поддержка OpenAI совместимого API: POST /api/chat/completions');
            logInfo('В ответе возвращаются chatId и parentId для продолжения диалога');
            logInfo('======================================================');

            getApiKeys();
            getAvailableModelsFromFile();
        });
    } catch (err) {
        if (err.code === 'EADDRINUSE') {
            logError(`Порт ${port} уже используется. Возможно, сервер уже запущен.`);
            await shutdownBrowser();
            process.exit(1);
        }
        throw err;
    }
}

startServer().catch(async error => {
    logError('Ошибка при запуске сервера', error);
    await shutdownBrowser();
    process.exit(1);
});
