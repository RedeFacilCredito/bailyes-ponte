// chatwoot_queue_worker.js (Versão corrigida usando o manipulador aprimorado)

const { Worker } = require('bullmq');
const P = require('pino');
const { createClient } = require('redis');

const { QUEUE_NAME, connection: redisConnection } = require('./queue_config.js');
const config = require('./config_unificado.js');
// --- MODIFICAÇÃO: Importar o manipulador aprimorado ---
const { processAndRelayMessageToChatwoot, setRedisClientForMap } = require('./chatwoot_manipulador_aprimorado.js');

const workerLoggerBase = P({
    level: config.CHATWOOT_QUEUE_WORKER_LOG_LEVEL || 'info',
    name: 'ChatwootQueueWorkerBase'
});

const concurrency = config.CHATWOOT_QUEUE_CONCURRENCY || 5;
const workerName = `chatwoot-processor-${process.pid}`;

workerLoggerBase.info(`Iniciando Chatwoot Queue Worker: ${workerName} para a fila "${QUEUE_NAME}" com concorrência ${concurrency}.`);

const workerRedisConnection = redisConnection.duplicate();
workerRedisConnection.on('connect', () => workerLoggerBase.info(`[${workerName}] Conectado ao Redis para BullMQ.`));
workerRedisConnection.on('error', (err) => {
    workerLoggerBase.error({ err }, `[${workerName}] Erro de conexão Redis para BullMQ. O worker pode não funcionar corretamente.`);
});

let redisClientForMap = null;

async function initializeRedisMapClient() {
    workerLoggerBase.info(`[${workerName}] Inicializando cliente Redis para mapeamento de IDs...`);
    redisClientForMap = createClient({
        url: config.REDIS_URL,
        username: config.REDIS_USER,
        password: config.REDIS_PASSWORD
    });
    redisClientForMap.on('error', (err) => workerLoggerBase.error({ err }, `[${workerName}] Erro de conexão com Redis para mapeamento de IDs.`));
    redisClientForMap.on('connect', () => workerLoggerBase.info(`[${workerName}] Conectado ao Redis para mapeamento de IDs.`));
    redisClientForMap.on('ready', () => workerLoggerBase.info(`[${workerName}] Redis para mapeamento de IDs pronto.`));
    try {
        await redisClientForMap.connect();
        workerLoggerBase.info(`[${workerName}] Conexão Redis para mapeamento de IDs estabelecida.`);
        // --- MODIFICAÇÃO: Injetar o cliente Redis no manipulador ---
        setRedisClientForMap(redisClientForMap);
    } catch (err) {
        workerLoggerBase.fatal({ err }, `[${workerName}] Falha CRÍTICA ao inicializar conexão Redis. Worker irá sair.`);
        process.exit(1);
    }
}

initializeRedisMapClient().then(() => {
    workerLoggerBase.info(`[${workerName}] Cliente Redis pronto. Iniciando worker da fila BullMQ.`);
    
    // --- MODIFICAÇÃO: Lógica do Worker simplificada ---
    const worker = new Worker(QUEUE_NAME, async (job) => {
        const jobLogger = workerLoggerBase.child({
            jobId: job.id,
            jobName: job.name,
            jobAttempts: `${job.attemptsMade}/${job.opts.attempts || config.BULLMQ_JOB_ATTEMPTS || 3}`,
            instanceId: job.data.instanceId,
            originalMsgId: job.data.logContext?.originalMessageId
        });
        
        jobLogger.info(`Iniciando processamento do job com o manipulador aprimorado.`);
        
        try {
            // *** ALTERAÇÃO AQUI: Extrai 'contentAttributes' do job ***
            const { baileysMessageDetails, relayConfig, contentAttributes } = job.data;
            if (!baileysMessageDetails || !relayConfig) {
                jobLogger.error({ jobData: job.data }, 'Dados do job incompletos.');
                throw new Error('Dados do job incompletos.');
            }
            
            // *** ALTERAÇÃO AQUI: Passa 'contentAttributes' para a função ***
            await processAndRelayMessageToChatwoot(baileysMessageDetails, relayConfig, jobLogger, contentAttributes);
            
            jobLogger.info(`Job processado com sucesso pelo manipulador.`);
        } catch (error) {
            const errorDetails = error.response ? { status: error.response.status, data: error.response.data } : { message: error.message };
            jobLogger.error({ err: errorDetails, stack: error.stack }, `Falha ao processar job no manipulador.`);
            throw error;
        }
    }, {
        connection: workerRedisConnection,
        concurrency: concurrency,
        removeOnComplete: { age: 3600 * 24 * 2, count: 1000 },
        removeOnFail: { age: 3600 * 24 * 7, count: 5000 }
    });

    worker.on('completed', (job) => workerLoggerBase.info({ jobId: job.id, instanceId: job.data.instanceId }, `Job completado.`));
    worker.on('failed', (job, err) => workerLoggerBase.warn({ jobId: job.id, instanceId: job.data.instanceId, error: err.message }, `Job falhou.`));
    worker.on('error', err => workerLoggerBase.error({ err }, `[${workerName}] Erro crítico no Worker BullMQ:`));
    worker.on('stalled', (jobId) => workerLoggerBase.warn({ jobId }, `Job estagnou (stalled).`));

    workerLoggerBase.info(`[${workerName}] Worker da fila Chatwoot iniciado e escutando por jobs.`);
    
    const shutdown = async () => {
        workerLoggerBase.info(`[${workerName}] Desligando o worker...`);
        await worker.close();
        await workerRedisConnection.quit();
        if (redisClientForMap && redisClientForMap.isOpen) {
            await redisClientForMap.quit();
            workerLoggerBase.info(`[${workerName}] Conexão Redis para mapeamento fechada.`);
        }
        workerLoggerBase.info(`[${workerName}] Worker desligado.`);
        process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

}).catch(err => {
    workerLoggerBase.fatal({ err }, `[${workerName}] Falha fatal na inicialização. Abortando.`);
    process.exit(1);
});
