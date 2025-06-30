// queue_config.js
const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const config = require('./config_unificado.js'); // Para pegar configs do Redis se necessário

const QUEUE_NAME = 'chatwoot-message-relay';

const connection = new IORedis(config.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null, // Padrão bullmq
    // Adicione user/password se configurou no Redis
    // username: config.REDIS_USER,
    // password: config.REDIS_PASSWORD,
});

connection.on('connect', () => console.log('[Redis] Conectado ao Redis para BullMQ.'));
connection.on('error', (err) => console.error('[Redis] Erro de conexão Redis para BullMQ:', err));

// Fila para enviar mensagens ao Chatwoot
const chatwootMessageQueue = new Queue(QUEUE_NAME, { connection });

chatwootMessageQueue.on('error', err => {
    console.error(`[BullMQ Queue ${QUEUE_NAME}] Erro na fila:`, err);
});

module.exports = {
    chatwootMessageQueue,
    QUEUE_NAME,
    connection // Exporta a conexão para ser usada pelos Workers da fila
};