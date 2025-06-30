// config_unificado.js
// Configurações centralizadas para a aplicação integrada

// Usar dotenv para carregar variáveis de ambiente de um arquivo .env (opcional, mas recomendado)
require('dotenv').config();

console.log("[Config Unificado] Carregando configurações...");

// --- Configurações do Servidor Principal e Cluster ---
const SERVER_PORT = process.env.SERVER_PORT || 3001;
const SERVER_LOG_LEVEL = process.env.SERVER_LOG_LEVEL || 'debug'; // Nível de log para o servidor principal
const MAX_WORKERS = parseInt(process.env.MAX_WORKERS || '0', 10); // 0 para usar todos os cores disponíveis, ou especifique um número
const STATUS_REQUEST_TIMEOUT = parseInt(process.env.STATUS_REQUEST_TIMEOUT || '5000', 10); // Timeout para coletar status dos workers

// --- Configurações do Baileys (para cada instância) ---
const BAILEYS_AUTH_SESSIONS_PARENT_DIR = process.env.BAILEYS_AUTH_SESSIONS_PARENT_DIR || 'automation_auth_sessions';
const BAILEYS_BROWSER_NAME = process.env.BAILEYS_BROWSER_NAME || 'ChatwootDynamicBridge';
const BAILEYS_LOG_LEVEL_INSTANCE = process.env.BAILEYS_LOG_LEVEL_INSTANCE || 'debug'; // Nível de log para cada instância Baileys
const BAILEYS_RECONNECT_DELAY_MS = parseInt(process.env.BAILEYS_RECONNECT_DELAY_MS || '10000', 10);
const BAILEYS_MAX_QR_SEND_ATTEMPTS = parseInt(process.env.BAILEYS_MAX_QR_SEND_ATTEMPTS || '4', 10);

// --- Configurações do Chatwoot (Globais para o Servidor e como Padrão para Relay) ---
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL || 'http://localhost:3000';
const CHATWOOT_API_ACCESS_TOKEN = process.env.CHATWOOT_API_ACCESS_TOKEN;
const CHATWOOT_API_TIMEOUT = parseInt(process.env.CHATWOOT_API_TIMEOUT || '15000', 10);
const DEFAULT_CHATWOOT_ACCOUNT_ID = parseInt(process.env.DEFAULT_CHATWOOT_ACCOUNT_ID || '1', 10);
const DEFAULT_RELAY_CHATWOOT_INBOX_ID = parseInt(process.env.DEFAULT_RELAY_CHATWOOT_INBOX_ID || '0', 10);

// --- Configurações do Webhook de Comando ---
const WEBHOOK_COMMAND_KEYWORD = (process.env.WEBHOOK_COMMAND_KEYWORD || "erga").toLowerCase();
const WEBHOOK_AUTHORIZED_PHONE_NUMBERS = process.env.WEBHOOK_AUTHORIZED_PHONE_NUMBERS || "+5585999999999";
const WEBHOOK_AUTHORIZED_AGENT_NAMES = process.env.WEBHOOK_AUTHORIZED_AGENT_NAMES || '';
const COMMAND_EXECUTOR_URL = process.env.COMMAND_EXECUTOR_URL;


// --- Configurações do Redis e BullMQ (para Fila de Mensagens) ---
const REDIS_URL = process.env.REDIS_URL || 'redis://:4Iu61TswdpgzfZkcKyFJ@127.0.0.1:6379';
const REDIS_USER = process.env.REDIS_USER || undefined; // Deixe undefined se não houver usuário
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined; // Deixe undefined se não houver senha
const CHATWOOT_QUEUE_WORKER_LOG_LEVEL = process.env.CHATWOOT_QUEUE_WORKER_LOG_LEVEL || 'info';
const CHATWOOT_QUEUE_CONCURRENCY = parseInt(process.env.CHATWOOT_QUEUE_CONCURRENCY || '5', 10);
const BULLMQ_JOB_ATTEMPTS = parseInt(process.env.BULLMQ_JOB_ATTEMPTS || '3', 10);
const BULLMQ_JOB_BACKOFF_DELAY = parseInt(process.env.BULLMQ_JOB_BACKOFF_DELAY || '5000', 10); // ms

// --- MODIFICAÇÃO INÍCIO: Adiciona configurações para mapeamento de IDs ---
const REDIS_MAP_KEY_PREFIX = process.env.REDIS_MAP_KEY_PREFIX || 'ponte_map:';
const REDIS_MAP_TTL_SECONDS = parseInt(process.env.REDIS_MAP_TTL_SECONDS || '604800', 10); // 7 dias
// --- MODIFICAÇÃO FIM ---

// --- Nome do Arquivo de Metadados ---
const METADATA_FILENAME = 'instance_meta.json';

// --- Validações Críticas ---
if (!CHATWOOT_BASE_URL || CHATWOOT_BASE_URL === 'http://SEU_CHATWOOT_URL.com' || CHATWOOT_BASE_URL === 'http://localhost:3000' && process.env.NODE_ENV === 'production') {
    console.warn(`AVISO DE CONFIGURAÇÃO: CHATWOOT_BASE_URL (${CHATWOOT_BASE_URL}) pode não estar configurado corretamente para produção.`);
}
if (!CHATWOOT_API_ACCESS_TOKEN || CHATWOOT_API_ACCESS_TOKEN === 'SEU_TOKEN_DE_ACESSO_DA_API_DO_CHATWOOT') {
    console.error("ERRO CRÍTICO DE CONFIGURAÇÃO: CHATWOOT_API_ACCESS_TOKEN não está definido ou está com valor padrão. Verifique o arquivo .env ou as variáveis de ambiente.");
    process.exit(1);
}
if (!DEFAULT_CHATWOOT_ACCOUNT_ID || DEFAULT_CHATWOOT_ACCOUNT_ID <= 0) {
    console.error("ERRO CRÍTICO DE CONFIGURAÇÃO: DEFAULT_CHATWOOT_ACCOUNT_ID não está definido ou é inválido. Verifique o arquivo .env ou as variáveis de ambiente.");
    process.exit(1);
}

// Log das configurações carregadas (exceto sensíveis)
console.log(`[Config Unificado] SERVER_PORT: ${SERVER_PORT}`);
console.log(`[Config Unificado] SERVER_LOG_LEVEL: ${SERVER_LOG_LEVEL}`);
console.log(`[Config Unificado] MAX_WORKERS: ${MAX_WORKERS === 0 ? 'Automático (todos os cores)' : MAX_WORKERS}`);
console.log(`[Config Unificado] CHATWOOT_BASE_URL: ${CHATWOOT_BASE_URL}`);
console.log(`[Config Unificado] DEFAULT_CHATWOOT_ACCOUNT_ID: ${DEFAULT_CHATWOOT_ACCOUNT_ID}`);
console.log(`[Config Unificado] DEFAULT_RELAY_CHATWOOT_INBOX_ID: ${DEFAULT_RELAY_CHATWOOT_INBOX_ID}`);
console.log(`[Config Unificado] WEBHOOK_COMMAND_KEYWORD: ${WEBHOOK_COMMAND_KEYWORD}`);
console.log(`[Config Unificado] WEBHOOK_AUTHORIZED_PHONE_NUMBERS: ${WEBHOOK_AUTHORIZED_PHONE_NUMBERS}`);
console.log(`[Config Unificado] WEBHOOK_AUTHORIZED_AGENT_NAMES: ${WEBHOOK_AUTHORIZED_AGENT_NAMES || 'Nenhum'}`);
console.log(`[Config Unificado] REDIS_URL: ${REDIS_URL}`);
if (REDIS_USER) console.log(`[Config Unificado] REDIS_USER: ${REDIS_USER}`);
console.log(`[Config Unificado] CHATWOOT_QUEUE_CONCURRENCY: ${CHATWOOT_QUEUE_CONCURRENCY}`);
console.log(`[Config Unificado] BULLMQ_JOB_ATTEMPTS: ${BULLMQ_JOB_ATTEMPTS}`);


module.exports = {
    SERVER_PORT,
    SERVER_LOG_LEVEL,
    MAX_WORKERS,
    STATUS_REQUEST_TIMEOUT,
    BAILEYS_AUTH_SESSIONS_PARENT_DIR,
    BAILEYS_BROWSER_NAME,
    BAILEYS_LOG_LEVEL_INSTANCE,
    BAILEYS_RECONNECT_DELAY_MS,
    BAILEYS_MAX_QR_SEND_ATTEMPTS,
    CHATWOOT_BASE_URL,
    CHATWOOT_API_ACCESS_TOKEN,
    CHATWOOT_API_TIMEOUT,
    DEFAULT_CHATWOOT_ACCOUNT_ID,
    DEFAULT_RELAY_CHATWOOT_INBOX_ID,
    WEBHOOK_COMMAND_KEYWORD,
    WEBHOOK_AUTHORIZED_PHONE_NUMBERS,
    WEBHOOK_AUTHORIZED_AGENT_NAMES,
    REDIS_URL,
    REDIS_USER,
    REDIS_PASSWORD,
    CHATWOOT_QUEUE_WORKER_LOG_LEVEL,
    CHATWOOT_QUEUE_CONCURRENCY,
    BULLMQ_JOB_ATTEMPTS,
    BULLMQ_JOB_BACKOFF_DELAY,
    METADATA_FILENAME,
    REDIS_MAP_KEY_PREFIX,
    REDIS_MAP_TTL_SECONDS,
    COMMAND_EXECUTOR_URL 
};
