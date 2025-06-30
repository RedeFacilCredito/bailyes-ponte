// comando_executor.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const P = require('pino');
const { execFile } = require('node:child_process');
const path = require('path');

// --- Configurações ---
const EXECUTOR_PORT = parseInt(process.env.COMMAND_EXECUTOR_PORT || '3003');
const LOG_LEVEL = process.env.COMMAND_EXECUTOR_LOG_LEVEL || 'info';

const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL;
const CHATWOOT_API_ACCESS_TOKEN = process.env.CHATWOOT_API_ACCESS_TOKEN;

const logger = P({ level: LOG_LEVEL }).child({ service: 'ComandoExecutor' });
const app = express();
app.use(bodyParser.json());

if (!CHATWOOT_BASE_URL || !CHATWOOT_API_ACCESS_TOKEN) {
    logger.fatal("ERRO CRÍTICO: CHATWOOT_BASE_URL ou CHATWOOT_API_ACCESS_TOKEN não definidos! O executor não pode operar.");
    process.exit(1);
}

/**
 * Envia uma mensagem de status de volta para a conversa no Chatwoot.
 */
async function sendStatusToChatwoot(accountId, conversationId, messageContent) {
    const statusLogger = logger.child({ chatwootMsgSender: true, accountId, conversationId });
    const chatwootAPI = axios.create({
        baseURL: `${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}`,
        headers: { 'api_access_token': CHATWOOT_API_ACCESS_TOKEN },
        timeout: 10000
    });

    try {
        statusLogger.info(`Enviando status para Chatwoot: "${messageContent.substring(0, 50)}..."`);
        await chatwootAPI.post(`/conversations/${conversationId}/messages`, {
            content: messageContent,
            message_type: 'outgoing',
            private: true
        });
        statusLogger.info("Mensagem de status enviada com sucesso.");
    } catch (error) {
        const errorDetails = error.response ? { status: error.response.status, data: error.response.data } : error.message;
        statusLogger.error({ error: errorDetails }, "Erro ao enviar mensagem de status para o Chatwoot.");
    }
}

// Endpoint principal que recebe os comandos para execução
app.post('/execute', async (req, res) => {
    const { command, accountId, conversationId, args } = req.body;
    const commandLogger = logger.child({ command, conversationId });

    if (!command || !accountId || !conversationId) {
        commandLogger.warn({ body: req.body }, "Solicitação inválida. Faltam parâmetros (command, accountId, conversationId).");
        return res.status(400).send({ error: 'Parâmetros insuficientes.' });
    }

    commandLogger.info("Comando recebido para execução.");
    // Responde imediatamente para o solicitante (chatwoot_sender) não ficar esperando
    res.status(202).send({ message: `Comando '${command}' recebido e sendo processado.` }); 

    let scriptPath = '';
    let scriptDir = '';

    // Mapeia o comando para o caminho do script correspondente
    switch (command) {
        case 'criar_caixa':
            scriptPath = '/home/eduardo/criar_usuario/iniciar_automacao.sh';
            break;
        case 'criar_usuario':
            scriptPath = '/home/eduardo/criar_usuario/criar_usuario.sh';
            break;
        default:
            commandLogger.warn("Comando desconhecido ou não mapeado.");
            await sendStatusToChatwoot(accountId, conversationId, `Erro: O comando '${command}' não é reconhecido.`);
            return;
    }

    scriptDir = path.dirname(scriptPath);
    await sendStatusToChatwoot(accountId, conversationId, `Comando '${command}' recebido. Iniciando automação...`);

    // Executa o script de forma assíncrona
    execFile(scriptPath, args || [], { cwd: scriptDir }, (error, stdout, stderr) => {
        if (error) {
            commandLogger.error({ err: error, stderr }, "Erro ao executar o script de automação.");
            sendStatusToChatwoot(accountId, conversationId, `ERRO na automação '${command}': ${error.message}\n\n${stderr}`);
            return;
        }
        commandLogger.info({ stdout, stderr }, "Script de automação executado com sucesso.");
        sendStatusToChatwoot(accountId, conversationId, `Automação '${command}' concluída com sucesso.\n\nSaída:\n${stdout || '(sem saída padrão)'}\n${stderr ? `Erros:\n${stderr}` : ''}`);
    });
});

app.listen(EXECUTOR_PORT, '0.0.0.0', () => {
    logger.info(`Serviço Executor de Comandos escutando na porta ${EXECUTOR_PORT}`);
});
