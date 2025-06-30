// ponte_server.js (Versão Final - Unifica Webhooks, Citação e Envio)

const Redis = require('ioredis');
const cluster = require('node:cluster');
const os = require('node:os');
const express = require('express');
const bodyParser = require('body-parser');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    isJidGroup,
    jidNormalizedUser,
    getContentType,
    proto
    
} = require('@whiskeysockets/baileys');
const P = require('pino');
const qrcode = require('qrcode');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('node:fs/promises');
const path = require('path');
const { randomUUID } = require('node:crypto');
const EventEmitter = require('node:events');
const { execFile } = require('node:child_process');


const config = require('./config_unificado.js');
const { parseBaileysMessageContent } = require('./analisador_mensagens.js');
const { chatwootMessageQueue, QUEUE_NAME } = require('./queue_config.js');

const HEALTH_CHECK_INTERVAL_MS = (config.HEALTH_CHECK_INTERVAL_MINUTES || 3) * 60 * 1000; // A cada 3 minutos por padrão
const HEALTH_CHECK_TIMEOUT_MS = 30000; // Timeout de 30 segundos para o health check



// Cliente Redis para mapeamento de IDs de mensagens
const redisClient = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: false,
});

redisClient.on('error', (err) => {
    console.error('[Redis Client Error]', err);
});


const numCPUs = Math.min(os.cpus().length, config.MAX_WORKERS || os.cpus().length);
const ABSOLUTE_AUTH_SESSIONS_PARENT_DIR = path.join(__dirname, config.BAILEYS_AUTH_SESSIONS_PARENT_DIR);

const IPC_MSG_TYPES = {
    REQUEST_MANAGE_INSTANCE: 'REQUEST_MANAGE_INSTANCE',
    DO_MANAGE_INSTANCE: 'DO_MANAGE_INSTANCE',
    INSTANCE_STATUS_UPDATE: 'INSTANCE_STATUS_UPDATE',
    REQUEST_WORKER_STATUS: 'REQUEST_WORKER_STATUS',
    WORKER_STATUS_RESPONSE: 'WORKER_STATUS_RESPONSE',
    ASSIGN_RECONNECT_INSTANCE: 'ASSIGN_RECONNECT_INSTANCE',
    SEND_WHATSAPP_MESSAGE_FROM_CHATWOOT: 'SEND_WHATSAPP_MESSAGE_FROM_CHATWOOT'
};

const globalStatusEmitter = new EventEmitter();
const STATUS_REQUEST_TIMEOUT = config.STATUS_REQUEST_TIMEOUT || 5000;

async function initializeWorker() {
    const workerLogger = P({ level: config.SERVER_LOG_LEVEL }).child({
        serverModule: 'PonteServerWorker',
        workerId: cluster.worker.id,
        pid: process.pid
    });

    const mainLogger = workerLogger;
    const baileysInstances = {};
    const recentlySentFromChatwootBaileysIDs = new Set();

    const app = express();
    app.use(bodyParser.json());

    mainLogger.info(`Worker ${cluster.worker.id} (PID: ${process.pid}) iniciado.`);

    async function ensureAuthSessionsDirExists() {
        try {
            await fs.mkdir(ABSOLUTE_AUTH_SESSIONS_PARENT_DIR, { recursive: true });
            mainLogger.info(`[DirSessao] Diretório de sessões garantido: ${ABSOLUTE_AUTH_SESSIONS_PARENT_DIR}`);
        } catch (error) {
            mainLogger.error(`[DirSessao] Erro crítico ao criar diretório de sessões: ${error.message}`);
            throw new Error(`Falha ao criar diretório de sessões: ${error.message}`);
        }
    }

    async function sendServerMessageToChatwoot(targetAccountId, targetConversationId, messageContent, qrImageBuffer = null, inboxNameForQrContext = 'default') {
        const instanceLogger = mainLogger.child({ chatwootMsgSender: true, targetAccountId, targetConversationId });
        if (!config.CHATWOOT_API_ACCESS_TOKEN) {
            instanceLogger.error("[ServerMsgCW] CHATWOOT_API_ACCESS_TOKEN não configurado.");
            return;
        }
        if (!targetAccountId || !targetConversationId) {
            instanceLogger.warn(`[ServerMsgCW] Account ID ou Conversation ID não fornecidos. Conteúdo: ${String(messageContent).substring(0, 50)}...`);
            return;
        }
        const chatwootAPI = axios.create({
            baseURL: `${config.CHATWOOT_BASE_URL}/api/v1/accounts/${targetAccountId}`,
            headers: { 'api_access_token': config.CHATWOOT_API_ACCESS_TOKEN },
            timeout: config.CHATWOOT_API_TIMEOUT
        });

        try {
            let requestData;
            let requestHeaders = {};

            if (qrImageBuffer) {
                // --- INÍCIO DA CORREÇÃO ---
                const formData = new FormData();
                formData.append('content', messageContent);
                formData.append('message_type', 'outgoing');
                formData.append('private', 'true'); 
                formData.append('attachments[]', qrImageBuffer, {
                    filename: `qrcode_inbox_${String(inboxNameForQrContext).replace(/\s+/g, '_')}_${Date.now()}.png`,
                    contentType: 'image/png'
                });

                // Preparamos os dados e os cabeçalhos ANTES de enviar para o Axios
                requestData = formData.getBuffer(); 
                requestHeaders = { ...formData.getHeaders() };
                // --- FIM DA CORREÇÃO ---
            } else {
                requestData = { content: messageContent, message_type: 'outgoing', private: true };
                requestHeaders['Content-Type'] = 'application/json';
            }

            instanceLogger.info(`[ServerMsgCW] Enviando msg para Conta ${targetAccountId}, Conv ${targetConversationId}. QR: ${qrImageBuffer ? 'Sim' : 'Não'}`);
            await chatwootAPI.post(`/conversations/${targetConversationId}/messages`, requestData, { headers: requestHeaders });
            instanceLogger.info(`[ServerMsgCW] Mensagem enviada com sucesso para conv ${targetConversationId}`);

        } catch (error) {
            const errorDetails = error.response ? { status: error.response.status, data: error.response.data } : { message: error.message, stack: error.stack };
            instanceLogger.error({ err: errorDetails }, `[ServerMsgCW] Erro ao enviar msg para Chatwoot (Conv ${targetConversationId})`);
        }
    }


    async function saveInstanceMetadata(instanceId, metadata) {
        const instanceLogger = baileysInstances[instanceId]?.logger || mainLogger.child({ instanceId, metaSave: true });
        const authDir = path.join(ABSOLUTE_AUTH_SESSIONS_PARENT_DIR, `session_instance_${instanceId}`);
        const metadataPath = path.join(authDir, config.METADATA_FILENAME);
        try {
            await fs.mkdir(authDir, { recursive: true });
            await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
            instanceLogger.info(`Metadados salvos: ${metadataPath}`);
        } catch (error) {
            instanceLogger.error(`Erro ao salvar metadados para ${instanceId}: ${error.message}`);
        }
    }
    
    async function startBaileysConnection(instanceId, initialMetadata) {
        let currentInstance = baileysInstances[instanceId];
        if (!currentInstance) {
            mainLogger.warn(`[BaileysConnect-${instanceId}] Instância não encontrada ao iniciar. Criando nova estrutura.`);
            baileysInstances[instanceId] = {
                sock: null, status: 'initializing', qrData: null, metadata: initialMetadata,
                lastError: null, reconnectTimeoutId: null, qrSendAttempts: 0,
                logger: mainLogger.child({ instanceId, workerId: cluster.worker.id })
            };
            currentInstance = baileysInstances[instanceId];
        } else {
            currentInstance.metadata = { ...currentInstance.metadata, ...initialMetadata };
            if (!['qr_pending', 'qr_limit_reached', 'qr_limit_reached_notified'].includes(currentInstance.status)) {
                currentInstance.qrSendAttempts = 0;
            }
            if (!currentInstance.logger) {
                currentInstance.logger = mainLogger.child({ instanceId, workerId: cluster.worker.id });
            }
        }
        const instanceLogger = currentInstance.logger;

        if (currentInstance.reconnectTimeoutId) {
            clearTimeout(currentInstance.reconnectTimeoutId);
            currentInstance.reconnectTimeoutId = null;
        }

        instanceLogger.info(`Iniciando conexão Baileys. Nome da Instância no Chatwoot: "${currentInstance.metadata.instanceChatwootInboxName}". Relay para Inbox: ${currentInstance.metadata.relayChatwootInboxId}, Conta: ${currentInstance.metadata.relayChatwootAccountId}`);
        currentInstance.status = 'connecting';
        await saveInstanceMetadata(instanceId, currentInstance.metadata);

        const authDirForInstance = path.join(ABSOLUTE_AUTH_SESSIONS_PARENT_DIR, `session_instance_${instanceId}`);
        try {
            await fs.mkdir(authDirForInstance, { recursive: true });
        } catch (err) {
            instanceLogger.debug(`Diretório de autenticação ${authDirForInstance} provavelmente já existe: ${err.message}`);
        }

        const { state, saveCreds } = await useMultiFileAuthState(authDirForInstance);
        const { version, isLatest } = await fetchLatestBaileysVersion();
        instanceLogger.info(`Usando Baileys v${version.join('.')} (É a mais recente: ${isLatest})`);

        const sock = makeWASocket({
            version,
            logger: P({ level: config.BAILEYS_LOG_LEVEL_INSTANCE }).child({ Fachwerk: 'Baileys', instanceId, workerId: cluster.worker.id }),
            auth: state,
            browser: Browsers.macOS(config.BAILEYS_BROWSER_NAME),
            printQRInTerminal: false,
            getMessage: async key => {
                instanceLogger.trace({ key }, 'GetMessage chamado (não implementado, retornando undefined)');
                return undefined;
            }
        });
        currentInstance.sock = sock;
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            instanceLogger.debug({ update }, 'Evento connection.update:');
            const { connection, lastDisconnect, qr: newQr } = update;
            const metaForMessaging = currentInstance.metadata;

            if (newQr) {
                instanceLogger.info('Novo QR Code recebido.');
                if (currentInstance.qrSendAttempts >= config.BAILEYS_MAX_QR_SEND_ATTEMPTS) {
                    instanceLogger.warn(`Limite de ${config.BAILEYS_MAX_QR_SEND_ATTEMPTS} tentativas de QR já atingido.`);
                    if (metaForMessaging.commandTargetConversationId && currentInstance.status !== 'qr_limit_reached_notified') {
                        await sendServerMessageToChatwoot(metaForMessaging.commandTargetAccountId, metaForMessaging.commandTargetConversationId, `Limite de ${config.BAILEYS_MAX_QR_SEND_ATTEMPTS} tentativas de QR Code atingido para "${metaForMessaging.instanceChatwootInboxName}". Não serão enviados mais QRs automaticamente. Use o comando novamente para tentar de novo.`, null, metaForMessaging.instanceChatwootInboxName);
                        currentInstance.status = 'qr_limit_reached_notified';
                    } else if (!metaForMessaging.commandTargetConversationId) {
                        instanceLogger.warn("Metadados de conversa para notificação de limite de QR não encontrados.");
                    }
                    if (currentInstance.status !== 'qr_limit_reached_notified') currentInstance.status = 'qr_limit_reached';
                    return;
                }
                currentInstance.qrData = newQr;
                currentInstance.status = 'qr_pending';
                currentInstance.qrSendAttempts = (currentInstance.qrSendAttempts || 0) + 1;
                instanceLogger.info(`Tentativa de envio de QR nº ${currentInstance.qrSendAttempts}/${config.BAILEYS_MAX_QR_SEND_ATTEMPTS}.`);

                if (metaForMessaging.commandTargetConversationId && metaForMessaging.commandTargetAccountId) {
                    try {
                        const qrImageBuffer = await qrcode.toBuffer(newQr, { scale: config.QRCODE_SCALE || 4, errorCorrectionLevel: 'L' });
                        instanceLogger.debug({
                        isBuffer: Buffer.isBuffer(qrImageBuffer),
                        type: typeof qrImageBuffer,
                        contentPreview: qrImageBuffer ? qrImageBuffer.toString('base64').substring(0, 50) + '...' : 'null'
                    }, 'DIAGNÓSTICO DO QR_IMAGE_BUFFER');
                        await sendServerMessageToChatwoot(metaForMessaging.commandTargetAccountId, metaForMessaging.commandTargetConversationId, `Tentativa ${currentInstance.qrSendAttempts}/${config.BAILEYS_MAX_QR_SEND_ATTEMPTS}: Escaneie o QR Code para "${metaForMessaging.instanceChatwootInboxName}"`, qrImageBuffer, metaForMessaging.instanceChatwootInboxName);
                    } catch (err) { instanceLogger.error('Erro ao gerar/enviar QR para Chatwoot:', err); 
                    instanceLogger.error({ err }, 'Erro detalhado ao gerar/enviar QR para Chatwoot:');
                    }
                } else {
                    instanceLogger.warn("Metadados de conversa (commandTargetConversationId ou commandTargetAccountId) para envio de QR não encontrados. O QR não será enviado ao Chatwoot.");
                }
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                let shouldAttemptAutoReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== DisconnectReason.connectionReplaced;

                if ((currentInstance.status === 'qr_limit_reached' || currentInstance.status === 'qr_limit_reached_notified' || (currentInstance.qrSendAttempts || 0) >= config.BAILEYS_MAX_QR_SEND_ATTEMPTS) && statusCode === DisconnectReason.timedOut) {
                    instanceLogger.warn(`Timeout de QR (status ${statusCode}) após ${currentInstance.qrSendAttempts} tentativas. Não tentará reconexão automática.`);
                    shouldAttemptAutoReconnect = false;
                }

                currentInstance.status = 'disconnected';
                let errorMessage = 'Desconexão sem erro específico.';
                if (lastDisconnect?.error) {
                    errorMessage = typeof lastDisconnect.error === 'string' ? lastDisconnect.error : (lastDisconnect.error.message || JSON.stringify(lastDisconnect.error));
                    instanceLogger.error({ error: lastDisconnect.error, statusCode }, 'Detalhes do erro de desconexão:');
                }
                currentInstance.lastError = errorMessage;
                
                currentInstance.reconnectAttempts = currentInstance.reconnectAttempts || 0;
                const maxReconnects = config.BAILEYS_MAX_RECONNECT_ATTEMPTS || 4; 

                if (shouldAttemptAutoReconnect) {
                    if (currentInstance.reconnectAttempts < maxReconnects) {
                        currentInstance.reconnectAttempts++;
                        const reconnectDelaySeconds = config.BAILEYS_RECONNECT_DELAY_MS / 1000;
                        const attemptMessage = `(${currentInstance.reconnectAttempts}/${maxReconnects})`;

                        instanceLogger.warn(`Conexão instável. Razão: ${errorMessage} (SC: ${statusCode}). Tentando reconectar ${attemptMessage} em ${reconnectDelaySeconds}s...`);
                        if (metaForMessaging.commandTargetConversationId) {
                            await sendServerMessageToChatwoot(metaForMessaging.commandTargetAccountId, metaForMessaging.commandTargetConversationId, `Conexão WhatsApp para "${metaForMessaging.instanceChatwootInboxName}" instável. Tentando reconectar... ${attemptMessage}`, null, metaForMessaging.instanceChatwootInboxName);
                        }

                        if (currentInstance.reconnectTimeoutId) clearTimeout(currentInstance.reconnectTimeoutId);
                        currentInstance.reconnectTimeoutId = setTimeout(() => {
                            instanceLogger.info(`Iniciando reconexão agendada ${attemptMessage} para instância ${instanceId}.`);
                            if (baileysInstances[instanceId] && baileysInstances[instanceId].status === 'disconnected') {
                                startBaileysConnection(instanceId, metaForMessaging)
                                    .catch(err => instanceLogger.error(`Erro na reconexão automática agendada para ${instanceId}:`, err));
                            } else {
                                instanceLogger.info(`Reconexão agendada para ${instanceId} não necessária (status atual: ${baileysInstances[instanceId]?.status}).`);
                            }
                        }, config.BAILEYS_RECONNECT_DELAY_MS);

                    } else {
                        shouldAttemptAutoReconnect = false;
                        instanceLogger.error(`LIMITE DE RECONEXÃO ATINGIDO (${maxReconnects} tentativas) para a instância ${instanceId}. Não haverá mais tentativas automáticas.`);
                        if (metaForMessaging.commandTargetConversationId) {
                           await sendServerMessageToChatwoot(metaForMessaging.commandTargetAccountId, metaForMessaging.commandTargetConversationId, `A conexão WhatsApp para "${metaForMessaging.instanceChatwootInboxName}" falhou após ${maxReconnects} tentativas. A reconexão automática foi interrompida. Use o comando de conexão novamente para tentar de novo.`, null, metaForMessaging.instanceChatwootInboxName);
                        }
                    }
                }
                
                if (!shouldAttemptAutoReconnect) {
                    currentInstance.reconnectAttempts = 0;
                    instanceLogger.info(`Conexão fechada. Razão: ${errorMessage} (SC: ${statusCode}). Não haverá reconexão automática.`);
                    if (metaForMessaging.commandTargetConversationId && currentInstance.reconnectAttempts >= maxReconnects) {
                         // A mensagem de limite atingido já foi enviada.
                    } else if (metaForMessaging.commandTargetConversationId) {
                        await sendServerMessageToChatwoot(metaForMessaging.commandTargetAccountId, metaForMessaging.commandTargetConversationId, `Conexão WhatsApp para "${metaForMessaging.instanceChatwootInboxName}" foi fechada. Razão: ${errorMessage}. Verifique o status ou use o comando novamente se necessário.`, null, metaForMessaging.instanceChatwootInboxName);
                    }

                    if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.connectionReplaced || !shouldAttemptAutoReconnect) {
                        instanceLogger.info(`Limpando pasta de autenticação ${authDirForInstance} devido a ${DisconnectReason[statusCode] || 'não reconexão'}.`);
                        await fs.rm(authDirForInstance, { recursive: true, force: true }).catch(err => {instanceLogger.warn(`Aviso ao limpar pasta de auth para ${instanceId}: ${err.message}`)});
                        if (baileysInstances[instanceId]) {
                            baileysInstances[instanceId].sock = null;
                        }
                    }
                }
            } else if (connection === 'open') {
                const wasPreviouslyOpen = currentInstance.status === 'open';
                currentInstance.status = 'open';
                currentInstance.qrData = null;
                currentInstance.lastError = null;
                currentInstance.qrSendAttempts = 0;
                currentInstance.reconnectAttempts = 0;
                if (currentInstance.reconnectTimeoutId) { clearTimeout(currentInstance.reconnectTimeoutId); currentInstance.reconnectTimeoutId = null; instanceLogger.info(`Reconexão bem-sucedida para ${instanceId}.`); }

                const connectedJid = sock.user?.id;
                currentInstance.metadata.connectedJid = connectedJid;
                await saveInstanceMetadata(instanceId, currentInstance.metadata);

                if (!wasPreviouslyOpen && metaForMessaging.commandTargetConversationId) {
                    await sendServerMessageToChatwoot(metaForMessaging.commandTargetAccountId, metaForMessaging.commandTargetConversationId, `WhatsApp para "${metaForMessaging.instanceChatwootInboxName}" conectado! JID: ${connectedJid}`, null, metaForMessaging.instanceChatwootInboxName);
                }
                instanceLogger.info(`CONECTADO AO WHATSAPP! JID: ${connectedJid}`);
            } else if (connection === 'connecting') {
                instanceLogger.info("Conexão Baileys em 'connecting'...");
            }
        });
        
        sock.ev.on('messages.upsert', async m => {
            const msgLoggerWithContext = instanceLogger.child({ event: 'messages.upsert', msgId: m.messages[0]?.key?.id });
            msgLoggerWithContext.debug({ messages: m }, "Evento messages.upsert recebido:");
            const msg = m.messages[0];
            if (!msg || !msg.message) {
                msgLoggerWithContext.debug("Mensagem vazia ou sem conteúdo principal, ignorando.");
                return;
            }
            if (msg.key.remoteJid === 'status@broadcast') {
                msgLoggerWithContext.debug("Notificação de status (story) ignorada.");
                return;
            }

            if (msg.key.fromMe) {
                msgLoggerWithContext.info(`[MsgUpsert] Mensagem 'fromMe' detectada (ID Baileys: ${msg.key.id}). Verificando se é eco do Chatwoot...`);
                if (recentlySentFromChatwootBaileysIDs.has(msg.key.id)) {
                    msgLoggerWithContext.info(`[MsgUpsert] Mensagem 'fromMe' (ID: ${msg.key.id}) é um ECO. IGNORANDO.`);
                    recentlySentFromChatwootBaileysIDs.delete(msg.key.id);
                    return;
                } else {
                    msgLoggerWithContext.info(`[MsgUpsert] Mensagem 'fromMe' (ID: ${msg.key.id}) NÃO é um eco conhecido. Será processada.`);
                }
            }

            let isEdit = false;
            let originalEditedMsgKey = null;
            let contentToParseLike = msg;

            const outerMessageType = getContentType(msg.message);
            if (outerMessageType === 'editedMessage' &&
                msg.message.editedMessage?.message?.protocolMessage?.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT &&
                msg.message.editedMessage.message.protocolMessage.editedMessage
            ) {
                const protocolMsgPayload = msg.message.editedMessage.message.protocolMessage;
                msgLoggerWithContext.info({
                    originalMsgId: protocolMsgPayload.key.id,
                    editEventId: msg.key.id,
                    sender: protocolMsgPayload.key.remoteJid
                }, `[MsgUpsert] MENSAGEM EDITADA detectada.`);

                isEdit = true;
                originalEditedMsgKey = protocolMsgPayload.key;
                contentToParseLike = {
                    key: originalEditedMsgKey,
                    message: protocolMsgPayload.editedMessage,
                    messageTimestamp: msg.messageTimestamp,
                    pushName: msg.pushName,
                };
            }

            const parsedContentDetails = await parseBaileysMessageContent(contentToParseLike, sock, msgLoggerWithContext.child({ module: 'AnalisadorMsg' }));

            if (!parsedContentDetails) {
                msgLoggerWithContext.debug("Mensagem (ou edição) não parseada ou sem conteúdo para relay. Ignorando.");
                return;
            }
            
            let contentAttributesForChatwoot = {};
            if (parsedContentDetails.isReply && parsedContentDetails.quotedMsgId) {
                msgLoggerWithContext.info(`É uma resposta ao Baileys ID: ${parsedContentDetails.quotedMsgId}. Buscando ID do Chatwoot no Redis...`);
                const redisKey = `${config.REDIS_MAP_KEY_PREFIX}${parsedContentDetails.quotedMsgId}`;
                try {
                    const chatwootReplyToId = await redisClient.get(redisKey);
                    if (chatwootReplyToId) {
                        msgLoggerWithContext.info(`[RedisMap] ID do Chatwoot encontrado: ${chatwootReplyToId}. Adicionando aos atributos.`);
                        contentAttributesForChatwoot.in_reply_to = parseInt(chatwootReplyToId, 10);
                    } else {
                        msgLoggerWithContext.warn(`[RedisMap] Não foi possível encontrar o ID do Chatwoot correspondente para o Baileys ID ${parsedContentDetails.quotedMsgId} no Redis.`);
                    }
                } catch (redisError) {
                    msgLoggerWithContext.error({ err: redisError }, `[RedisMap] Erro ao buscar ID do Chatwoot para o Baileys ID ${parsedContentDetails.quotedMsgId}`);
                }
            }
            
            if (isEdit && originalEditedMsgKey) {
                const originalMsgIdForDisplay = originalEditedMsgKey.id.substring(0, 10);
                parsedContentDetails.textContent = `✏️ _(Mensagem ${originalMsgIdForDisplay} editada)_\n${parsedContentDetails.textContent || ''}`;
            }

            let finalMessageKeyForContext = isEdit ? originalEditedMsgKey : msg.key;
            let chatPartnerJidForChatwoot;
            let contactPushNameToUse; 
            let originalSenderInfo = "";
            let avatarUrl = null;
            const isGroupMsg = isJidGroup(finalMessageKeyForContext.remoteJid);
            if (isGroupMsg) {
                const groupJid = finalMessageKeyForContext.remoteJid;
                msgLoggerWithContext.info(`Mensagem em GRUPO: ${groupJid}`);
                chatPartnerJidForChatwoot = groupJid;

                // --- INÍCIO DO CÓDIGO DE DIAGNÓSTICO E BUSCA DE METADADOS ---
                try {
                    // ETAPA 1: Diagnóstico - Verificando o que a sessão já conhece
                    const allKnownGroups = await sock.groupFetchAllParticipating();
                    const isGroupKnownBySession = !!allKnownGroups[groupJid];

                    msgLoggerWithContext.info({
                        totalKnownGroups: Object.keys(allKnownGroups).length,
                        isCurrentGroupKnown: isGroupKnownBySession,
                        currentGroupJid: groupJid
                    }, 'DIAGNÓSTICO DE GRUPO');

                    // ETAPA 2: Tentando buscar os metadados do grupo atual
                    const groupMeta = await sock.groupMetadata(groupJid);
                    contactPushNameToUse = `${groupMeta.subject || groupJid.split('@')[0]} (Grupo)`;
                    avatarUrl = await sock.profilePictureUrl(groupJid).catch(() => null);

                } catch (err) {
                    msgLoggerWithContext.warn(`Falha inicial ao obter metadados do grupo: ${err.message}. Aguardando 3 segundos e tentando novamente...`);
                    await new Promise(resolve => setTimeout(resolve, 3000));

                    try {
                        // ETAPA 3: Segunda tentativa após a pausa
                        const groupMeta = await sock.groupMetadata(groupJid);
                        msgLoggerWithContext.info("Sucesso na 2ª tentativa de obter metadados do grupo.");
                        contactPushNameToUse = `${groupMeta.subject || groupJid.split('@')[0]} (Grupo)`;
                        avatarUrl = await sock.profilePictureUrl(groupJid).catch(() => null);
                    } catch (finalErr) {
                        // Se falhar de novo, usa o fallback e registra o erro final
                        msgLoggerWithContext.error({ err: finalErr }, `Falha CRÍTICA na 2ª tentativa de obter metadados. Usando ID como fallback.`);
                        contactPushNameToUse = `${groupJid.split('@')[0]} (Grupo)`;
                        avatarUrl = null;
                    }
                }
                // --- FIM DO CÓDIGO DE DIAGNÓSTICO E BUSCA DE METADADOS ---

                const actualSenderParticipantJid = msg.key.participant || finalMessageKeyForContext.participant;

                if (!finalMessageKeyForContext.fromMe && actualSenderParticipantJid) {
                    const participantJid = jidNormalizedUser(actualSenderParticipantJid);
                    const participantName = msg.pushName || participantJid.split('@')[0];
                    originalSenderInfo = `De: ${participantName} (+${participantJid.split('@')[0]}):\n`;
                }
            } else {
                chatPartnerJidForChatwoot = finalMessageKeyForContext.remoteJid;

                if (!finalMessageKeyForContext.fromMe) {
                    contactPushNameToUse = msg.pushName || finalMessageKeyForContext.remoteJid.split('@')[0];
                }
                
                try {
                    avatarUrl = await sock.profilePictureUrl(chatPartnerJidForChatwoot, 'image');
                    if (avatarUrl) msgLoggerWithContext.debug(`Avatar URL obtido para ${chatPartnerJidForChatwoot}`);
                } catch (picError) {
                    msgLoggerWithContext.warn(`Não foi possível buscar foto do perfil para ${chatPartnerJidForChatwoot}: ${picError.message}`);
                    avatarUrl = null;
                }
            }
            const finalMessageTextContentForChatwoot = originalSenderInfo + (parsedContentDetails.textContent || "");

            const baileysMessageDetailsForChatwoot = {
                ...parsedContentDetails,
                textContent: finalMessageTextContentForChatwoot,
                chatPartnerJid: chatPartnerJidForChatwoot,
                contactPushName: contactPushNameToUse,
                messageTimestamp: isEdit ? contentToParseLike.messageTimestamp : msg.messageTimestamp,
                isFromMe: finalMessageKeyForContext.fromMe,
                avatarUrl: avatarUrl,
                isGroup: isGroupMsg,
                messageIdBaileys: msg.key.id,
                isEditEvent: isEdit,
                originalEditedMsgId: isEdit ? originalEditedMsgKey.id : null,
            };

            const currentMeta = baileysInstances[instanceId]?.metadata;
            if (!currentMeta || !currentMeta.relayChatwootInboxId || !currentMeta.relayChatwootAccountId) {
                msgLoggerWithContext.error(`Metadados de relay não encontrados para instância ${instanceId}. Mensagem não será adicionada à fila.`);
                return;
            }
            const effectiveInstanceId = currentMeta.instanceId || instanceId;

            const relayConfigForJob = {
                CHATWOOT_BASE_URL: config.CHATWOOT_BASE_URL,
                CHATWOOT_ACCOUNT_ID: currentMeta.relayChatwootAccountId,
                CHATWOOT_API_ACCESS_TOKEN: config.CHATWOOT_API_ACCESS_TOKEN,
                CHATWOOT_INBOX_ID: currentMeta.relayChatwootInboxId,
                CHATWOOT_API_TIMEOUT: config.CHATWOOT_API_TIMEOUT,
            };

            try {
                const jobData = {
                    baileysMessageDetails: baileysMessageDetailsForChatwoot,
                    relayConfig: relayConfigForJob,
                    instanceId: effectiveInstanceId,
                    contentAttributes: contentAttributesForChatwoot,
                    logContext: {
                        workerId: cluster.worker.id,
                        originalMessageId: msg.key.id,
                        baileysEventType: m.type,
                        contactOrGroupJid: finalMessageKeyForContext.remoteJid,
                        isEdit: isEdit,
                        hasQuote: !!(parsedContentDetails.isReply)
                    }
                };
                await chatwootMessageQueue.add('send-to-chatwoot', jobData, {});
                msgLoggerWithContext.info(`Mensagem (Baileys ID: ${msg.key.id}, Editada: ${isEdit}, Citação: ${!!(parsedContentDetails.isReply)}) adicionada à fila "${QUEUE_NAME}" para Chatwoot. Instance ID: ${effectiveInstanceId}`);
            } catch (queueError) {
                msgLoggerWithContext.error({ err: queueError, msgId: msg.key.id, instanceId: effectiveInstanceId }, `Erro ao adicionar mensagem à fila "${QUEUE_NAME}"`);
            }
        });
    }

    async function manageBaileysInstance(instanceId, commandMetadata, isStartupReconnect = false) {
        if (!baileysInstances[instanceId]) {
            mainLogger.info(`[ManageInstance-${instanceId}] Criando nova estrutura de instância ao gerenciar (instruído pelo primário ou startup).`);
            baileysInstances[instanceId] = {
                sock: null, status: 'initializing', qrData: null, metadata: commandMetadata,
                lastError: null, reconnectTimeoutId: null, qrSendAttempts: 0,
                logger: mainLogger.child({ instanceId, manageInstance: true, workerId: cluster.worker.id })
            };
        } else {
            baileysInstances[instanceId].metadata = { ...baileysInstances[instanceId].metadata, ...commandMetadata };
            if (!baileysInstances[instanceId].logger) {
                baileysInstances[instanceId].logger = mainLogger.child({ instanceId, manageInstance: true, workerId: cluster.worker.id });
            }
        }
        const current = baileysInstances[instanceId];
        const instanceLogger = current.logger;

        instanceLogger.info(`Gerenciando instância (Worker ${cluster.worker.id}). Status atual: ${current.status}. Solicitado por: ${isStartupReconnect ? 'StartupReconnectIPC' : 'PrimarioIPC'}. Metadados: %o`, commandMetadata);

        if (current.status === 'open' && !isStartupReconnect) {
            instanceLogger.info(`Solicitação para (re)gerar QR para instância já conectada (${instanceId}). Desconectando para gerar novo QR...`);
            if (current.metadata.commandTargetConversationId && current.metadata.commandTargetAccountId) {
                await sendServerMessageToChatwoot(current.metadata.commandTargetAccountId, current.metadata.commandTargetConversationId, `Solicitação para gerar novo QR Code para a instância "${current.metadata.instanceChatwootInboxName}". Desconectando a sessão atual...`, null, current.metadata.instanceChatwootInboxName);
            }
            if (current.sock) {
                try {
                    await current.sock.logout("Novo QR Code solicitado via comando/IPC.");
                    instanceLogger.info("Logout da sessão Baileys bem-sucedido.");
                } catch (e) {
                    instanceLogger.error("Erro durante o logout da sessão Baileys:", e);
                    const authDir = path.join(ABSOLUTE_AUTH_SESSIONS_PARENT_DIR, `session_instance_${instanceId}`);
                    instanceLogger.warn(`Tentando limpar pasta de autenticação ${authDir} após falha no logout.`);
                    await fs.rm(authDir, { recursive: true, force: true }).catch(errRm => instanceLogger.error(`Falha ao limpar pasta de autenticação ${authDir}: ${errRm.message}`));
                }
            }
            current.sock = null;
            current.status = 'initializing';
            current.qrSendAttempts = 0;
            current.qrData = null;
            current.lastError = null;
        // Substitua pelo novo bloco em manageBaileysInstance
        } else if (current.status === 'qr_pending' && current.qrData && !isStartupReconnect) {
            if (current.qrSendAttempts >= config.BAILEYS_MAX_QR_SEND_ATTEMPTS) {
                // ... (lógica de limite de tentativas)
            } else {
                instanceLogger.info(`Reenviando QR Code existente para ${instanceId} (tentativa ${current.qrSendAttempts + 1}/${config.BAILEYS_MAX_QR_SEND_ATTEMPTS}).`);
                current.qrSendAttempts++;
                try {
                    const qrImageBuffer = await qrcode.toBuffer(current.qrData, { scale: config.QRCODE_SCALE || 4, errorCorrectionLevel: 'L' });

                    // ---> ADICIONE O DIAGNÓSTICO AQUI <---
                    instanceLogger.debug({
                        isBuffer: Buffer.isBuffer(qrImageBuffer),
                        type: typeof qrImageBuffer,
                        qrDataInputType: typeof current.qrData,
                        qrDataInputPreview: current.qrData ? String(current.qrData).substring(0, 70) + '...' : 'null'
                    }, 'DIAGNÓSTICO DO QR_IMAGE_BUFFER (Reenvio)');

                    if (current.metadata.commandTargetConversationId && current.metadata.commandTargetAccountId) {
                        await sendServerMessageToChatwoot(current.metadata.commandTargetAccountId, current.metadata.commandTargetConversationId, `Tentativa ${current.qrSendAttempts}/${config.BAILEYS_MAX_QR_SEND_ATTEMPTS}: QR Code para "${current.metadata.instanceChatwootInboxName}" (reenvio):`, qrImageBuffer, current.metadata.instanceChatwootInboxName);
                    }
                } catch (err) {
                    instanceLogger.error({ err }, 'Erro ao gerar/enviar QR Code existente:');
                }
            }
            return;
        }

        if (
            ['disconnected', 'error', 'initializing'].includes(current.status) ||
            (isStartupReconnect && current.status !== 'open') ||
            ((current.status === 'qr_limit_reached' || current.status === 'qr_limit_reached_notified') && !isStartupReconnect)
        ) {
            if (isStartupReconnect && current.status === 'open' && current.sock) {
                instanceLogger.info(`Instância ${instanceId} já está conectada (verificação de startup via IPC). Nenhuma ação necessária.`);
                return;
            }

            instanceLogger.info(`Status da instância ${instanceId} é '${current.status}'. Tentando iniciar/conectar (Startup via IPC: ${isStartupReconnect})...`);
            if ((current.status === 'qr_limit_reached' || current.status === 'qr_limit_reached_notified') && !isStartupReconnect) {
                instanceLogger.info(`Resetando contador de QR e status para ${instanceId} devido a novo comando (via IPC).`);
                current.qrSendAttempts = 0;
                current.status = 'initializing';
                current.qrData = null;
                current.lastError = null;
            }
            await startBaileysConnection(instanceId, current.metadata);
        } else if (current.status === 'connecting' || (current.status === 'qr_pending' && !isStartupReconnect)) {
            instanceLogger.info(`Instância ${instanceId} já está em processo de '${current.status}'. Aguardando conclusão.`);
        } else if (current.status === 'open' && isStartupReconnect) {
            instanceLogger.info(`Instância ${instanceId} já está 'open' durante a reconexão de startup (instruído via IPC). Verificando consistência dos metadados.`);
            if (current.sock?.user?.id) current.metadata.connectedJid = current.sock.user.id;
            await saveInstanceMetadata(instanceId, current.metadata);
        } else {
            instanceLogger.warn(`Estado não esperado para instância ${instanceId}: ${current.status}. Nenhuma ação tomada por manageBaileysInstance.`);
        }
    async function runHealthChecks() {
        const healthLogger = mainLogger.child({ module: 'HealthCheck' });
        healthLogger.info(`Iniciando verificação de saúde para ${Object.keys(baileysInstances).length} instâncias neste worker.`);

        for (const [instanceId, instanceData] of Object.entries(baileysInstances)) {
            if (instanceData.status === 'open' && instanceData.sock) {
                const instanceLogger = instanceData.logger || healthLogger.child({ instanceId });
                instanceLogger.info('[HealthCheck] Verificando instância...');

                try {
                    // Usamos Promise.race para criar um timeout para a verificação
                    await Promise.race([
                        instanceData.sock.sendPresenceUpdate('available', instanceData.sock.user.id),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Health check timed out')), HEALTH_CHECK_TIMEOUT_MS)
                        )
                    ]);
                    instanceLogger.info('[HealthCheck] Verificação de presença bem-sucedida. Conexão está ativa.');
                } catch (err) {
                    instanceLogger.warn({ err: err.message }, `[HealthCheck] FALHOU! A conexão para a instância ${instanceId} parece estar "zumbi". Acionando reconexão forçada.`);
                    
                    const meta = instanceData.metadata;
                    if (meta && meta.commandTargetAccountId && meta.commandTargetConversationId) {
                        await sendServerMessageToChatwoot(
                            meta.commandTargetAccountId,
                            meta.commandTargetConversationId,
                            `⚠️ A conexão WhatsApp para "${meta.instanceChatwootInboxName}" parecia inativa e foi reiniciada automaticamente para garantir a estabilidade.`,
                            null,
                            meta.instanceChatwootInboxName
                        );
                    }
                    
                    // Aciona a mesma lógica do "erga", reiniciando a conexão
                    // Define o status para 'disconnected' para que startBaileysConnection execute
                    instanceData.status = 'disconnected';
                    instanceData.lastError = 'Health check failed, forcing reconnect.';
                    if (instanceData.reconnectTimeoutId) clearTimeout(instanceData.reconnectTimeoutId);

                    startBaileysConnection(instanceId, meta)
                        .catch(reconnectErr => {
                            instanceLogger.error({ err: reconnectErr }, `[HealthCheck] Erro durante a tentativa de reconexão forçada.`);
                        });
                }
            }
        }
    }
    }


    // --- NOVA SEÇÃO: Lógica de Webhook movida para cá ---
    // Rota ÚNICA para receber TODOS os webhooks do Chatwoot
    app.post('/webhook/chatwoot', async (req, res) => {
        const payload = req.body;
        const webhookLogger = mainLogger.child({
            webhook: 'chatwoot-router',
            chatwootMessageId: payload.id || 'N/A',
            conversationId: payload.conversation?.id,
            workerId: cluster.worker.id
        });

        webhookLogger.info('Webhook do Chatwoot recebido para roteamento...');
        webhookLogger.debug({ payload }, 'Payload completo do webhook:');

        // --- Validações Iniciais (ignorar eventos desnecessários) ---
        if (payload.event !== 'message_created') {
            webhookLogger.info(`Evento '${payload.event}' ignorado.`);
            return res.status(200).send({ message: 'Evento não processado.' });
        }
        
        if (payload.sender?.type !== 'user') {
            webhookLogger.info(`Mensagem ignorada, não é de um agente (sender.type: ${payload.sender?.type}).`);
            return res.status(200).send({ message: 'Não é mensagem de agente.' });
        }

        if (payload.private) {
            webhookLogger.info(`Mensagem privada (nota) detectada. Ignorando.`);
            return res.status(200).send({ message: 'Nota privada ignorada.' });
        }

        // --- Lógica de Comandos e Autorização ---
        const messageContent = payload.content || "";
        const commandParts = messageContent.toLowerCase().trim().split(/\s+/);
        const commandKeyword = commandParts[0];

        const managementCommand = config.WEBHOOK_COMMAND_KEYWORD; // ex: "erga"
        const automationCommands = ['criar_caixa', 'criar_usuario']; // Adicione outros comandos de automação aqui
        
        const isProtectedCommand = commandKeyword === managementCommand || automationCommands.includes(commandKeyword);

        // --- INÍCIO DA LÓGICA DE AUTORIZAÇÃO ---
        if (isProtectedCommand) {
            const agentName = payload.sender?.name;
            const contactPhone = payload.contact?.phone_number;

            // Pega as listas de autorizados da configuração
            const authorizedNames = (config.WEBHOOK_AUTHORIZED_AGENT_NAMES || '').split(',').map(name => name.trim().toLowerCase());
            const authorizedPhones = (config.WEBHOOK_AUTHORIZED_PHONE_NUMBERS || '').split(',').map(phone => phone.trim());

            let isAuthorized = false;
            // Verifica se o nome do agente OU o telefone do contato estão na lista de permissão
            if (agentName && authorizedNames.includes(agentName.toLowerCase())) {
                isAuthorized = true;
            } else if (contactPhone && authorizedPhones.includes(contactPhone)) {
                isAuthorized = true;
            }

            // Se nenhuma das listas de autorização estiver configurada, permite a execução por padrão
            if (authorizedNames.length === 0 && authorizedPhones.length === 0) {
                webhookLogger.warn("Nenhuma lista de autorização configurada (WEBHOOK_AUTHORIZED_AGENT_NAMES ou WEBHOOK_AUTHORIZED_PHONE_NUMBERS). Comandos estão desprotegidos.");
                isAuthorized = true;
            }

            if (!isAuthorized) {
                webhookLogger.warn({ agentName, contactPhone, command: commandKeyword }, 'Tentativa de execução de comando protegido por usuário não autorizado.');
                // Envia uma mensagem de volta para o Chatwoot informando sobre a falha na autorização
                const accountId = payload.account?.id;
                const conversationId = payload.conversation?.id;
                if (accountId && conversationId) {
                    sendServerMessageToChatwoot(accountId, conversationId, `❌ Acesso Negado! O usuário "${agentName}" não tem permissão para executar o comando "${commandKeyword}".`);
                }
                return res.status(403).send({ error: 'Não autorizado.' });
            }
        }
        // --- FIM DA LÓGICA DE AUTORIZAÇÃO ---

        // --- ROTEAMENTO INTELIGENTE ---
        if (commandKeyword === managementCommand) {
            webhookLogger.info("Comando de gerenciamento 'erga' detectado e autorizado.");
            const instanceIdToManage = payload.inbox?.id?.toString();
            // ... (resto da lógica do comando erga, sem alterações)
            const commandTargetConversationId = payload.conversation?.id?.toString();
            const commandTargetAccountId = payload.account?.id?.toString();
            if (!instanceIdToManage || !commandTargetConversationId || !commandTargetAccountId) {
                webhookLogger.warn('[Comando erga] Dados insuficientes no payload.');
                return res.status(400).send({ error: 'Dados insuficientes para o comando erga.' });
            }
            const commandMetadata = {
                instanceId: instanceIdToManage,
                instanceChatwootInboxName: payload.inbox?.name || `Instancia_${instanceIdToManage}`,
                commandTargetConversationId,
                commandTargetAccountId,
                relayChatwootInboxId: parseInt(commandParts[1] || instanceIdToManage, 10),
                relayChatwootAccountId: parseInt(commandParts[2] || commandTargetAccountId, 10),
                triggeredBy: `Agente: ${payload.sender?.name} (Conv: ${commandTargetConversationId})`
            };
            if (process.send) {
                process.send({ type: IPC_MSG_TYPES.REQUEST_MANAGE_INSTANCE, payload: { instanceId: instanceIdToManage, commandMetadata, requestingWorkerId: cluster.worker.id }});
                return res.status(202).send({ message: 'Comando de gerenciamento encaminhado.' });
            } else {
                return res.status(500).send({ error: 'Erro de comunicação interna.' });
            }
        }

        if (automationCommands.includes(commandKeyword)) {
            webhookLogger.info(`Comando de automação '${commandKeyword}' detectado e autorizado.`);
            // ... (resto da lógica dos comandos de automação, sem alterações)
            const commandPayload = {
                command: commandKeyword,
                accountId: payload.account.id,
                conversationId: payload.conversation.id,
                args: commandParts.slice(1)
            };
            try {
                await axios.post(`${config.COMMAND_EXECUTOR_URL}/execute`, commandPayload);
                return res.status(202).send({ message: 'Comando de automação encaminhado.' });
            } catch (error) {
                webhookLogger.error({ err: error.message }, 'Erro ao encaminhar comando para o executor.');
                return res.status(500).send({ error: 'Falha ao contatar o executor de comandos.' });
            }
        }

        // --- Rota para Mensagem Normal (para o WhatsApp) ---
        if (payload.source_id) {
            webhookLogger.info(`Mensagem com source_id ('${payload.source_id}') detectada. Ignorando para prevenir loop.`);
            return res.status(200).send({ message: 'Eco da ponte ignorado.' });
        }
        
        webhookLogger.info("Mensagem normal de agente detectada. Preparando para enviar ao WhatsApp.");
        // ... (resto da lógica de envio de mensagem normal, sem alterações)
        const instanceId = payload.inbox?.id?.toString();
        const recipientIdentifier = payload.conversation?.meta?.sender?.identifier ||
                                payload.conversation?.contact_inbox?.source_id ||
                                payload.contact?.identifier ||
                                (payload.contact?.phone_number ? payload.contact.phone_number.replace('+', '') + '@s.whatsapp.net' : null);
        if (!instanceId || !recipientIdentifier) {
            webhookLogger.warn({ payload }, 'Dados insuficientes no webhook para envio (instanceId ou recipientIdentifier).');
            return res.status(400).send({ error: 'Dados insuficientes para envio.' });
        }
        let mediaUrl = null, mediaTypeForBaileys = null, mediaMimetypeToSend = null, mediaFileNameToSend = null;
        let captionForMedia = payload.content || "";
        if (payload.attachments && payload.attachments.length > 0) {
            const attachment = payload.attachments[0];
            mediaUrl = attachment.data_url;
            mediaFileNameToSend = attachment.name || `midia_${Date.now()}`;
            mediaMimetypeToSend = attachment.content_type || 'application/octet-stream';
            mediaTypeForBaileys = attachment.file_type;
        }
        let quotedMessageInfo = null;
        const inReplyToId = payload.content_attributes?.in_reply_to;
        if (inReplyToId && config.CHATWOOT_BASE_URL && config.CHATWOOT_API_ACCESS_TOKEN) {
            try {
                const chatwootApi = axios.create({
                    baseURL: `${config.CHATWOOT_BASE_URL}/api/v1/accounts/${payload.account.id}`,
                    headers: { 'api_access_token': config.CHATWOOT_API_ACCESS_TOKEN }
                });
                const { data: originalMsgDetails } = await chatwootApi.get(`/messages/${inReplyToId}`);
                const stanzaIdForQuote = originalMsgDetails.source_id;
                if (stanzaIdForQuote) {
                    let participantForQuote = undefined;
                    const isIncomingQuote = originalMsgDetails.message_type === 'incoming';
                    if (recipientIdentifier.includes('@g.us') && isIncomingQuote) {
                        const originalSenderIdentifier = originalMsgDetails.sender?.phone_number || originalMsgDetails.contact?.phone_number;
                        if (originalSenderIdentifier) {
                            participantForQuote = `${originalSenderIdentifier.replace('+', '')}@s.whatsapp.net`;
                        }
                    }
                    quotedMessageInfo = {
                        stanzaId: stanzaIdForQuote,
                        participant: participantForQuote,
                        message: { "conversation": originalMsgDetails.content || "[Mídia]" },
                        fromMe: !isIncomingQuote,
                    };
                }
            } catch(error) {
                webhookLogger.error({ err: error.message }, `Falha ao buscar detalhes da mensagem citada (ID: ${inReplyToId}).`);
            }
        }
        const ipcPayload = {
            instanceId,
            recipientIdentifier,
            messageContent: captionForMedia,
            chatwootMessageId: payload.id,
            mediaUrl,
            mediaType: mediaTypeForBaileys,
            mediaMimetype: mediaMimetypeToSend,
            mediaFileName: mediaFileNameToSend,
            caption: captionForMedia,
            quotedMessageInfo
        };
        if (process.send) {
            process.send({ type: IPC_MSG_TYPES.SEND_WHATSAPP_MESSAGE_FROM_CHATWOOT, payload: ipcPayload });
            return res.status(202).send({ message: 'Mensagem encaminhada para envio.' });
        } else {
            return res.status(500).send({ error: 'Erro de comunicação interna.' });
        }
    });
    
    app.get('/status', (req, res) => {
        const now = new Date();
        const statusLogger = mainLogger.child({ route: '/status', workerId: cluster.worker.id });
        statusLogger.info("Requisição de status local recebida.");

        const instanceSummary = Object.values(baileysInstances).map(data => {
            let statusColor = '\x1b[33m';
            if (data.status === 'open') statusColor = '\x1b[32m';
            else if (['disconnected', 'qr_limit_reached', 'qr_limit_reached_notified', 'error'].includes(data.status) || data.lastError) statusColor = '\x1b[31m';
            const resetColor = '\x1b[0m';
            return {
                instanceId: data.metadata?.instanceId,
                workerId: cluster.worker.id,
                instanceName: data.metadata?.instanceChatwootInboxName || 'N/A',
                status: data.status || 'N/A',
                statusDisplay: `${statusColor}${String(data.status || 'N/A').toUpperCase()}${resetColor}`,
                connectedJid: data.sock?.user?.id || data.metadata?.connectedJid || 'N/A',
                qrPending: !!data.qrData,
                lastError: data.lastError || null,
                qrSendAttempts: data.qrSendAttempts || 0,
                relayToInboxId: data.metadata?.relayChatwootInboxId || 'N/A',
                relayToAccountId: data.metadata?.relayChatwootAccountId || 'N/A',
            };
        });
        statusLogger.info(`Retornando status de ${instanceSummary.length} instâncias neste worker.`);
        res.json({
            message: `Servidor Ponte (Worker ${cluster.worker.id}) Baileys-Chatwoot está rodando.`,
            serverTime: now.toISOString(),
            activeInstancesCountOnWorker: instanceSummary.length,
            instancesOnWorker: instanceSummary
        });
    });

// Substitua todo o seu bloco process.on('message', ...) por este:

    process.on('message', async (msg) => {
        mainLogger.info(`[IPC] Worker ${cluster.worker.id} recebeu mensagem do primário: Tipo ${msg.type}, Payload: ${JSON.stringify(msg.payload).substring(0,200)}...`);
        if (typeof msg === 'object' && msg.type) {
            switch (msg.type) {
                case IPC_MSG_TYPES.DO_MANAGE_INSTANCE:
                    const { instanceId, commandMetadata } = msg.payload;
                    mainLogger.info(`[IPC] Worker ${cluster.worker.id} instruído pelo primário para gerenciar instância ${instanceId} (comando).`);
                    try {
                        await manageBaileysInstance(instanceId, commandMetadata, false);
                    } catch (error) {
                        mainLogger.error({ err: error, instanceId }, `[IPC] Erro ao executar manageBaileysInstance para ${instanceId} após instrução do primário (comando).`);
                    }
                    break;
                case IPC_MSG_TYPES.ASSIGN_RECONNECT_INSTANCE:
                    const { instanceId: reconInstanceId, commandMetadata: reconCmdMetadata } = msg.payload;
                    mainLogger.info(`[IPC] Worker ${cluster.worker.id} instruído pelo primário para RECONECTAR instância ${reconInstanceId} (startup).`);
                    try {
                        await manageBaileysInstance(reconInstanceId, reconCmdMetadata, true);
                    } catch (error) {
                        mainLogger.error({ err: error, instanceId: reconInstanceId }, `[IPC] Erro ao executar manageBaileysInstance para ${reconInstanceId} após instrução de RECONEXÃO do primário.`);
                    }
                    break;
                case IPC_MSG_TYPES.REQUEST_WORKER_STATUS:
                    const statusRequestId = msg.payload?.statusRequestId;
                    mainLogger.info(`[IPC] Worker ${cluster.worker.id} recebeu REQUEST_WORKER_STATUS (ID: ${statusRequestId}) do primário.`);
                    const instanceSummary = Object.values(baileysInstances).map(data => ({
                        instanceId: data.metadata?.instanceId,
                        workerId: cluster.worker.id,
                        instanceName: data.metadata?.instanceChatwootInboxName || 'N/A',
                        status: data.status || 'N/A',
                        connectedJid: data.sock?.user?.id || data.metadata?.connectedJid || 'N/A',
                        qrPending: !!data.qrData,
                        lastError: data.lastError || null,
                        qrSendAttempts: data.qrSendAttempts || 0,
                        relayToInboxId: data.metadata?.relayChatwootInboxId || 'N/A',
                        relayToAccountId: data.metadata?.relayChatwootAccountId || 'N/A',
                    }));
                    if (process.send) {
                        process.send({
                            type: IPC_MSG_TYPES.WORKER_STATUS_RESPONSE,
                            payload: {
                                workerId: cluster.worker.id,
                                instances: instanceSummary,
                                statusRequestId: statusRequestId
                            }
                        });
                        mainLogger.info(`[IPC] Worker ${cluster.worker.id} enviou WORKER_STATUS_RESPONSE (ID: ${statusRequestId}) para o primário com ${instanceSummary.length} instâncias.`);
                    }
                    break;
                
                // --- INÍCIO DO BLOCO CORRIGIDO ---
                case IPC_MSG_TYPES.SEND_WHATSAPP_MESSAGE_FROM_CHATWOOT:
                    const {
                        instanceId: targetInstanceId,
                        recipientIdentifier,
                        messageContent,
                        chatwootMessageId,
                        mediaUrl,
                        mediaType,
                        mediaMimetype,
                        mediaFileName,
                        caption,
                        quotedMessageInfo
                    } = msg.payload;

                    const workerSendLogger = mainLogger.child({
                        ipcType: 'SEND_WHATSAPP_MESSAGE_FROM_CHATWOOT',
                        targetInstanceId,
                        recipientIdentifier,
                        chatwootMessageId,
                        mediaType,
                        hasQuotedInfo: !!quotedMessageInfo,
                        workerId: cluster.worker.id
                    });

                    workerSendLogger.info(`[CW->WA] Recebida instrução para enviar mensagem via WhatsApp.`);
                    const currentInstance = baileysInstances[targetInstanceId];

                    if (currentInstance && currentInstance.sock && currentInstance.status === 'open') {
                        let normalizedJid;
                        try {
                            const cleanedIdentifier = recipientIdentifier.replace(/\s+/g, '').replace(/^\+/, '');
                            if (cleanedIdentifier.includes('@g.us') || cleanedIdentifier.includes('@s.whatsapp.net')) {
                                normalizedJid = cleanedIdentifier;
                            } else if (/^\d+$/.test(cleanedIdentifier)) {
                                normalizedJid = `${cleanedIdentifier}@s.whatsapp.net`;
                            } else {
                                throw new Error(`Identificador "${recipientIdentifier}" não é um número válido nem um JID completo.`);
                            }
                            normalizedJid = jidNormalizedUser(normalizedJid);
                            if (!normalizedJid || !normalizedJid.includes('@')) throw new Error('Normalização final do Baileys falhou.');

                        } catch (e) {
                            workerSendLogger.error({ err: e, identifier: recipientIdentifier }, "[CW->WA] Erro ao normalizar JID do destinatário.");
                            break;
                        }

                        try {
                            let messageToSend = {};
                            let options = {};
                            
                            // 1. Gerar um ID único para a mensagem ANTES de enviar
                            const generatedMsgId = randomUUID().replace(/-/g, '').substring(0, 16).toUpperCase();

                            // 2. Adicionar este ID à lista de controle IMEDIATAMENTE
                            recentlySentFromChatwootBaileysIDs.add(generatedMsgId);
                            workerSendLogger.info(`[CW->WA] ID de mensagem gerado e pré-registrado para eco: ${generatedMsgId}`);
                            
                            // Limpa o ID da lista de controle após um tempo para não consumir memória
                            setTimeout(() => {
                                if(recentlySentFromChatwootBaileysIDs.delete(generatedMsgId)) {
                                    workerSendLogger.debug(`[CW->WA] ID pré-registrado ${generatedMsgId} removido do controle de eco após timeout.`);
                                }
                            }, 60000);
                            
                            if (quotedMessageInfo && quotedMessageInfo.stanzaId) {
                                const quotedMsgBaileys = {
                                    key: {
                                        remoteJid: normalizedJid,
                                        fromMe: quotedMessageInfo.fromMe === true,
                                        id: quotedMessageInfo.stanzaId,
                                        participant: quotedMessageInfo.participant || undefined
                                    },
                                    message: quotedMessageInfo.message
                                };
                                if (isJidGroup(recipientIdentifier) && quotedMsgBaileys.key.fromMe && !quotedMsgBaileys.key.participant) {
                                    const botJid = currentInstance.metadata?.connectedJid;
                                    if (botJid) {
                                        quotedMsgBaileys.key.participant = jidNormalizedUser(botJid);
                                    }
                                }
                                options.quoted = quotedMsgBaileys;
                            }

                            if (mediaUrl && mediaType) {
                                // Lógica de Mídia (sem alterações)
                                const publicIpOfThisVps = "82.25.65.10"; 
                                let effectiveMediaUrl = mediaUrl;
                                if (mediaUrl && mediaUrl.startsWith(`http://${publicIpOfThisVps}`)) {
                                    effectiveMediaUrl = mediaUrl.replace(`http://${publicIpOfThisVps}`, "http://localhost");
                                }
                                const response = await axios.get(effectiveMediaUrl, { responseType: 'arraybuffer' });
                                const mediaBuffer = Buffer.from(response.data);
                                const effectiveCaption = caption || messageContent || "";
                                switch (mediaType.toLowerCase()) {
                                    case 'image': messageToSend = { image: mediaBuffer, caption: effectiveCaption, mimetype: mediaMimetype || 'image/jpeg' }; break;
                                    case 'audio':
                                    case 'ptt': messageToSend = { audio: mediaBuffer, mimetype: mediaMimetype || 'audio/ogg', ptt: mediaType.toLowerCase() === 'ptt' }; break;
                                    case 'document':
                                    case 'file': messageToSend = { document: mediaBuffer, mimetype: mediaMimetype || 'application/pdf', fileName: mediaFileName || 'documento.bin' }; break;
                                    case 'video': messageToSend = { video: mediaBuffer, caption: effectiveCaption, mimetype: mediaMimetype || 'video/mp4' }; break;
                                    default: messageToSend = { text: `[Mídia não suportada: ${mediaFileName || mediaType}]\n${caption || messageContent}` };
                                }
                            } else if (messageContent || messageContent === "") {
                                messageToSend = { text: messageContent };
                            }

                            if (Object.keys(messageToSend).length > 0) {
                                // 3. Passar o ID gerado nas opções de envio
                                const sentMsgInfo = await currentInstance.sock.sendMessage(normalizedJid, messageToSend, { ...options, messageId: generatedMsgId });
                                workerSendLogger.info(`[CW->WA] Mensagem (Chatwoot ID: ${chatwootMessageId}, Baileys ID: ${sentMsgInfo.key.id}) enviada para ${normalizedJid}.`);
                                
                                if (sentMsgInfo?.key?.id && chatwootMessageId) {
                                    const redisKey = `${config.REDIS_MAP_KEY_PREFIX}${sentMsgInfo.key.id}`;
                                    await redisClient.set(redisKey, chatwootMessageId, 'EX', config.REDIS_MAP_TTL_SECONDS);
                                    workerSendLogger.info(`[RedisMap] Mapeamento salvo: Baileys ID ${sentMsgInfo.key.id} -> Chatwoot ID ${chatwootMessageId}`);
                                }
                            } else {
                                workerSendLogger.warn(`[CW->WA] Nenhuma mensagem construída para enviar. Chatwoot ID: ${chatwootMessageId}.`);
                            }

                        } catch (error) {
                            workerSendLogger.error({ err: error, stack: error.stack }, `[CW->WA] Erro ao enviar mensagem para ${normalizedJid}.`);
                        }
                    } else {
                        workerSendLogger.warn(`[CW->WA] Instância ${targetInstanceId} não conectada ou indisponível. Status: ${currentInstance?.status}. Mensagem (Chatwoot ID: ${chatwootMessageId}) não enviada.`);
                    }
                    break;
                // --- FIM DO BLOCO CORRIGIDO ---

                default:
                    mainLogger.warn(`[IPC] Worker ${cluster.worker.id} recebeu tipo de mensagem desconhecido do primário: ${msg.type}`);
            }
        }
    });
    async function startWorkerServer() {
        mainLogger.info(`================== Worker ${cluster.worker.id} (PID: ${process.pid}) ==================`);
        try {
            await ensureAuthSessionsDirExists();
        } catch (e) {
            mainLogger.fatal(`Falha crítica ao garantir diretório de sessões: ${e.message}. Worker ${cluster.worker.id} saindo.`);
            process.exit(1);
        }
        if (!config.CHATWOOT_API_ACCESS_TOKEN || !config.CHATWOOT_BASE_URL) {
            mainLogger.fatal("ERRO CRÍTICO: CHATWOOT_API_ACCESS_TOKEN ou CHATWOOT_BASE_URL não definidos! O worker não pode operar corretamente.");
            process.exit(1);
        }
        
        mainLogger.info(`Worker ${cluster.worker.id} aguardando instruções do primário para reconexão de sessões.`);

        const serverInstance = app.listen(config.SERVER_PORT, () => {
            mainLogger.info(`Worker ${cluster.worker.id} configurou servidor Express para escutar na porta ${config.SERVER_PORT} (gerenciado pelo cluster).`);
        });
        serverInstance.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                mainLogger.warn(`Porta ${config.SERVER_PORT} já em uso no worker ${cluster.worker.id}. Isso é esperado se o primário estiver gerenciando a porta.`);
            } else {
                mainLogger.fatal({ err }, `Erro fatal no servidor Express do worker ${cluster.worker.id}. Saindo.`);
                process.exit(1);
            }
        });
        setInterval(runHealthChecks, HEALTH_CHECK_INTERVAL_MS);
        mainLogger.info(`Worker ${cluster.worker.id} pronto e operacional. Verificador de saúde ativado para rodar a cada ${HEALTH_CHECK_INTERVAL_MS / 60000} minutos.`);
        mainLogger.info(`Worker ${cluster.worker.id} pronto e operacional.`);
    }

    startWorkerServer().catch(error => {
        mainLogger.fatal({ err: error }, `Falha fatal ao iniciar o Worker ${cluster.worker.id}. Saindo...`);
        process.exit(1);
    });
}


// --- Lógica do Processo Primário ---
if (cluster.isPrimary) {
    const primaryLogger = P({ level: config.SERVER_LOG_LEVEL }).child({ serverModule: 'PonteServerPrimary', pid: process.pid });
    primaryLogger.info(`Processo Primário ${process.pid} está rodando.`);
    primaryLogger.info(`Disponível ${os.cpus().length} CPUs. Tentando criar ${numCPUs} workers.`);
    primaryLogger.info(`Diretório de sessões configurado para: ${ABSOLUTE_AUTH_SESSIONS_PARENT_DIR}`);
    
    if (!config.REDIS_URL) {
        primaryLogger.fatal("ERRO CRÍTICO DE CONFIGURAÇÃO NO PRIMÁRIO: REDIS_URL não definida! A fila não funcionará. Verifique config_unificado.js e .env");
    }
    const INTERNAL_API_SECRET_PONTE = config.INTERNAL_API_SECRET || null;
    if (INTERNAL_API_SECRET_PONTE) {
        primaryLogger.info("[API Interna] Segredo da API interna está configurado.");
    } else {
        primaryLogger.warn("[API Interna] Segredo da API interna NÃO está configurado. O endpoint /internal-api/send-whatsapp está desprotegido.");
    }

    const instanceWorkerMap = {};
    let nextWorkerIndex = 0;
    let onlineWorkersCount = 0;

    const appPrimary = express();
    appPrimary.use(bodyParser.json());

    async function readInstanceMetadataForPrimary(instanceId) {
        const metadataPath = path.join(ABSOLUTE_AUTH_SESSIONS_PARENT_DIR, `session_instance_${instanceId}`, config.METADATA_FILENAME);
        try {
            const data = await fs.readFile(metadataPath, 'utf-8');
            primaryLogger.debug(`[PrimaryMetaRead] Metadados lidos para ${instanceId} de ${metadataPath}`);
            return JSON.parse(data);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                primaryLogger.error(`[PrimaryMetaRead] Erro ao ler metadados para ${instanceId}: ${error.message}`);
            } else {
                primaryLogger.debug(`[PrimaryMetaRead] Arquivo de metadados não encontrado para ${instanceId}: ${metadataPath}`);
            }
            return null;
        }
    }

    async function assignReconnectTasksToWorkers() {
        primaryLogger.info("[PrimaryStartup] Iniciando atribuição de tarefas de reconexão para workers...");
        try {
            await fs.mkdir(ABSOLUTE_AUTH_SESSIONS_PARENT_DIR, { recursive: true });
            const sessionDirs = await fs.readdir(ABSOLUTE_AUTH_SESSIONS_PARENT_DIR, { withFileTypes: true });
            const activeWorkers = Object.values(cluster.workers).filter(w => w && w.isConnected() && !w.isDead());

            if (activeWorkers.length === 0) {
                primaryLogger.warn("[PrimaryStartup] Nenhum worker ativo para atribuir tarefas de reconexão.");
                return;
            }
            primaryLogger.info(`[PrimaryStartup] ${activeWorkers.length} workers ativos para distribuição de sessões.`);

            for (const dirent of sessionDirs) {
                if (dirent.isDirectory() && dirent.name.startsWith('session_instance_')) {
                    const instanceId = dirent.name.replace('session_instance_', '');
                    const instanceStartupLogger = primaryLogger.child({ instanceId, startupAssign: true });

                    instanceStartupLogger.info(`[PrimaryStartup] Processando pasta de sessão: ${dirent.name}`);
                    const metadata = await readInstanceMetadataForPrimary(instanceId);

                    if (metadata && metadata.instanceChatwootInboxName && metadata.relayChatwootInboxId && metadata.relayChatwootAccountId) {
                        instanceStartupLogger.info(`[PrimaryStartup] Metadados OK para ${instanceId}. Nome: "${metadata.instanceChatwootInboxName}".`);
                        const targetWorker = activeWorkers[nextWorkerIndex % activeWorkers.length];
                        nextWorkerIndex++;

                        if (targetWorker) {
                            instanceStartupLogger.info(`[PrimaryStartup] Atribuindo instância ${instanceId} ao Worker ${targetWorker.id}.`);
                            instanceWorkerMap[instanceId] = { workerId: targetWorker.id, commandMetadata: metadata };

                            targetWorker.send({
                                type: IPC_MSG_TYPES.ASSIGN_RECONNECT_INSTANCE,
                                payload: {
                                    instanceId: instanceId,
                                    commandMetadata: metadata
                                }
                            });
                        } else {
                            instanceStartupLogger.error(`[PrimaryStartup] Nenhum worker alvo encontrado para ${instanceId}.`);
                        }
                    } else {
                        instanceStartupLogger.warn(`[PrimaryStartup] Metadados ausentes ou incompletos para ${instanceId}. Não será atribuída. Metadata: %o`, metadata);
                    }
                }
            }
        } catch (error) {
            if (error.code === 'ENOENT') {
                primaryLogger.info(`[PrimaryStartup] Diretório de sessões (${ABSOLUTE_AUTH_SESSIONS_PARENT_DIR}) não encontrado. Nenhuma sessão para reconectar.`);
            } else {
                primaryLogger.error("[PrimaryStartup] Erro crítico ao listar/atribuir diretórios de sessão:", error);
            }
        }
        primaryLogger.info("[PrimaryStartup] Atribuição de tarefas de reconexão concluída.");
    }

    appPrimary.get('/global-status', async (req, res) => {
        const requestLogger = primaryLogger.child({ route: '/global-status' });
        requestLogger.info("Requisição /global-status recebida pelo Primário.");

        const activeWorkers = Object.values(cluster.workers).filter(w => w && w.isConnected() && !w.isDead());
        if (activeWorkers.length === 0) {
            requestLogger.warn("Nenhum worker ativo para consultar status.");
            return res.status(200).json({
                message: "Nenhum worker ativo no momento.",
                serverTime: new Date().toISOString(),
                totalActiveInstances: 0,
                instancesGlobal: []
            });
        }

        const statusRequestId = randomUUID();
        const promises = activeWorkers.map(worker => {
            return new Promise((resolve) => {
                const eventName = `status-response-${statusRequestId}-${worker.id}`;
                const timeoutId = setTimeout(() => {
                    globalStatusEmitter.off(eventName, handleResponse);
                    requestLogger.warn(`Timeout esperando status do Worker ${worker.id} (Req ID: ${statusRequestId}).`);
                    resolve({ workerId: worker.id, status: 'timeout', instances: [] });
                }, STATUS_REQUEST_TIMEOUT);

                function handleResponse(payload) {
                    clearTimeout(timeoutId);
                    globalStatusEmitter.off(eventName, handleResponse);
                    if (payload && payload.workerId === worker.id) {
                        requestLogger.info(`Status recebido do Worker ${worker.id} (Req ID: ${statusRequestId}). Instâncias: ${payload.instances.length}`);
                        resolve({ workerId: worker.id, status: 'ok', instances: payload.instances });
                    } else {
                        requestLogger.warn(`Resposta de status malformada ou de worker inesperado. Worker: ${worker.id}, Payload: %o`, payload);
                        resolve({ workerId: worker.id, status: 'error_payload', instances: [] });
                    }
                }
                globalStatusEmitter.on(eventName, handleResponse);
                requestLogger.info(`Enviando REQUEST_WORKER_STATUS para Worker ${worker.id} (Req ID: ${statusRequestId})`);
                worker.send({ type: IPC_MSG_TYPES.REQUEST_WORKER_STATUS, payload: { statusRequestId } });
            });
        });

        try {
            const results = await Promise.allSettled(promises);
            let allInstances = [];
            results.forEach(result => {
                if (result.status === 'fulfilled' && result.value.status === 'ok') {
                    allInstances = allInstances.concat(result.value.instances);
                } else if (result.status === 'fulfilled') {
                    requestLogger.warn(`Problema ao obter status do worker ${result.value.workerId}: ${result.value.status}`);
                } else {
                    requestLogger.error(`Promise de status rejeitada: %o`, result.reason);
                }
            });
            const totalActiveInstances = allInstances.length;
            requestLogger.info(`Total de ${totalActiveInstances} instâncias agregadas de ${activeWorkers.length} workers.`);
            res.json({
                message: "Status global de todas as instâncias Baileys.",
                serverTime: new Date().toISOString(),
                totalActiveInstances: totalActiveInstances,
                instancesGlobal: allInstances,
                workersQueried: activeWorkers.length,
                workersResponded: results.filter(r => r.status === 'fulfilled' && r.value.status === 'ok').length
            });
        } catch (error) {
            requestLogger.error({ err: error }, "Erro ao processar /global-status.");
            res.status(500).json({ error: "Erro interno ao buscar status global." });
        }
    });

    const primaryManagementPort = parseInt(config.SERVER_PORT) + 100;
    appPrimary.listen(primaryManagementPort, '0.0.0.0', () => {
        primaryLogger.info(`Processo Primário (PID: ${process.pid}) escutando na porta de GERENCIAMENTO ${primaryManagementPort} para rotas como /global-status.`);
    }).on('error', (err) => {
        primaryLogger.fatal({ err }, `Falha ao iniciar servidor de gerenciamento do primário na porta ${primaryManagementPort}. Saindo.`);
        process.exit(1);
    });

    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    cluster.on('fork', (worker) => {
        primaryLogger.info(`Worker ${worker.id} (PID: ${worker.process.pid}) foi criado.`);
        worker.on('message', (msg) => {
            primaryLogger.debug(`[IPC] Primário recebeu mensagem do Worker ${worker.id}: Tipo ${msg.type}, Payload: %o`, msg.payload);
            
            if (typeof msg === 'object' && msg.type) {
                switch (msg.type) {
                    case IPC_MSG_TYPES.REQUEST_MANAGE_INSTANCE:
                        const { instanceId, commandMetadata, requestingWorkerId } = msg.payload;
                        primaryLogger.info(`[IPC] Solicitação do Worker ${requestingWorkerId || worker.id} para gerenciar instância ${instanceId}.`);
                        let assignedWorkerId;

                        if (instanceWorkerMap[instanceId] && 
                            instanceWorkerMap[instanceId].workerId && 
                            cluster.workers[instanceWorkerMap[instanceId].workerId] && 
                            cluster.workers[instanceWorkerMap[instanceId].workerId].isConnected() &&
                            !cluster.workers[instanceWorkerMap[instanceId].workerId].isDead()
                        ) {
                            assignedWorkerId = instanceWorkerMap[instanceId].workerId;
                            primaryLogger.info(`[IPC] Instância ${instanceId} já está atribuída ao Worker ATIVO ${assignedWorkerId}. Reenviando comando para ele.`);
                        } else {
                            const activeWorkerPids = Object.values(cluster.workers).filter(w => w && w.isConnected() && !w.isDead()).map(w => w.id);
                            if (activeWorkerPids.length === 0) {
                                primaryLogger.error("[IPC] Nenhum worker ATIVO disponível para atribuir instância.");
                                return;
                            }
                            const currentTargetWorkerId = activeWorkerPids[nextWorkerIndex % activeWorkerPids.length];
                            assignedWorkerId = currentTargetWorkerId;
                            nextWorkerIndex++;
                            primaryLogger.info(`[IPC] Atribuindo/Reatribuindo instância ${instanceId} ao Worker ATIVO ${assignedWorkerId} (RoundRobin).`);
                        }
                        
                        instanceWorkerMap[instanceId] = { workerId: assignedWorkerId, commandMetadata: commandMetadata };
                        const targetWorkerProcess = cluster.workers[assignedWorkerId];

                        if (targetWorkerProcess && targetWorkerProcess.isConnected() && !targetWorkerProcess.isDead()) {
                            primaryLogger.info(`[IPC] Primário instruindo Worker ${assignedWorkerId} para gerenciar ${instanceId}.`);
                            targetWorkerProcess.send({
                                type: IPC_MSG_TYPES.DO_MANAGE_INSTANCE,
                                payload: { instanceId, commandMetadata }
                            });
                        } else {
                            primaryLogger.error(`[IPC] Worker ATIVO ${assignedWorkerId} não encontrado ou não conectado para enviar instrução DO_MANAGE_INSTANCE para ${instanceId}.`);
                            delete instanceWorkerMap[instanceId];
                        }
                        break;
                    case IPC_MSG_TYPES.WORKER_STATUS_RESPONSE:
                        const { workerId: statusWorkerId, instances, statusRequestId } = msg.payload;
                        if (statusRequestId) {
                            primaryLogger.info(`[IPC] Primário recebeu WORKER_STATUS_RESPONSE do Worker ${statusWorkerId} para Req ID ${statusRequestId}. Instâncias: ${instances.length}`);
                            globalStatusEmitter.emit(`status-response-${statusRequestId}-${statusWorkerId}`, msg.payload);
                        } else {
                            primaryLogger.warn(`[IPC] WORKER_STATUS_RESPONSE recebido sem statusRequestId do Worker ${statusWorkerId}. Ignorando.`);
                        }
                        break;
                    case IPC_MSG_TYPES.SEND_WHATSAPP_MESSAGE_FROM_CHATWOOT:
                        const ipcPayload = msg.payload;
                        const targetInstanceId = ipcPayload.instanceId;
                        const primaryIpcLogger = primaryLogger.child({ ipcType: 'SEND_WHATSAPP_MESSAGE_FROM_CHATWOOT', targetInstanceId });
                        
                        primaryIpcLogger.info(`Primário recebeu solicitação de envio do Worker ${worker.id}. Roteando...`);
                    
                        if (instanceWorkerMap[targetInstanceId] && instanceWorkerMap[targetInstanceId].workerId) {
                            const targetWorkerId = instanceWorkerMap[targetInstanceId].workerId;
                            const targetWorkerProcess = cluster.workers[targetWorkerId];
                    
                            if (targetWorkerProcess && targetWorkerProcess.isConnected()) {
                                primaryIpcLogger.info(`Encaminhando para o worker correto: ${targetWorkerId}`);
                                targetWorkerProcess.send(msg); // Reencaminha a mensagem IPC original com todos os detalhes
                            } else {
                                primaryIpcLogger.error(`Worker alvo ${targetWorkerId} para a instância ${targetInstanceId} não está mais ativo.`);
                            }
                        } else {
                            primaryIpcLogger.error(`Instância ${targetInstanceId} não está mapeada a nenhum worker.`);
                        }
                        break;
                    default:
                        primaryLogger.warn(`[IPC] Primário recebeu tipo de mensagem desconhecido do Worker ${worker.id}: ${msg.type}`);
                }
            }
        });
    });

    cluster.on('online', (worker) => {
        primaryLogger.info(`Worker ${worker.id} (PID: ${worker.process.pid}) está online.`);
        onlineWorkersCount++;
        if (onlineWorkersCount === numCPUs) {
            primaryLogger.info(`Todos os ${numCPUs} workers estão online. O Primário iniciará a atribuição de sessões existentes.`);
            assignReconnectTasksToWorkers();
        }
    });

    cluster.on('listening', (worker, address) => {
        primaryLogger.info(`Worker ${worker.id} (PID: ${worker.process.pid}) configurou listener em ${address.address}:${address.port} (gerenciado pelo cluster).`);
    });

    cluster.on('disconnect', (worker) => {
        primaryLogger.warn(`Worker ${worker.id} (PID: ${worker.process.pid}) desconectou.`);
        onlineWorkersCount--;
    });

    cluster.on('exit', (worker, code, signal) => {
        primaryLogger.error(`Worker ${worker.id} (PID: ${worker.process.pid}) morreu com código ${code} e sinal ${signal}.`);
        if (!worker.exitedAfterDisconnect) {
          onlineWorkersCount--;
        }
        for (const instanceId in instanceWorkerMap) {
            if (instanceWorkerMap[instanceId].workerId === worker.id) {
                primaryLogger.info(`[IPC] Worker ${worker.id} morreu. Removendo atribuição da instância ${instanceId}.`);
                delete instanceWorkerMap[instanceId];
            }
        }
        if (code !== 0 && !worker.exitedAfterDisconnect) {
            primaryLogger.info('Worker morreu inesperadamente. Reiniciando um novo worker...');
            cluster.fork();
        } else if (worker.exitedAfterDisconnect) {
            primaryLogger.info(`Worker ${worker.id} saiu de forma controlada.`);
        }
    });

} else {
    initializeWorker();
}
