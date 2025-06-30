// chatwoot_manipulador_aprimorado.js
const axios = require('axios');
const FormData = require('form-data');
const P = require('pino');
const { getContentType } = require('@whiskeysockets/baileys'); 

const config = require('./config_unificado.js');
const defaultLogger = P({ level: config.CHATWOOT_QUEUE_WORKER_LOG_LEVEL || 'info', name: 'ChatwootHandlerBase' });

let redisClientForMap = null; 

async function setBaileysIdToChatwootId(baileysId, chatwootId, currentLogger) { 
    if (!redisClientForMap || !redisClientForMap.isOpen) {
        currentLogger.error(`[Redis Map] Cliente Redis NÃO ESTÁ CONECTADO para salvar mapeamento ${baileysId}. Operação ignorada.`);
        return;
    }
    const key = `${config.REDIS_MAP_KEY_PREFIX || 'baileys_chatwoot_msg_map:'}${baileysId}`;
    const TTL_SECONDS = config.REDIS_MAP_TTL_SECONDS || (60 * 60 * 24 * 7); 
    try {
        await redisClientForMap.set(key, chatwootId, { EX: TTL_SECONDS });
        currentLogger.debug(`[Redis Map] Mapeamento ${baileysId} -> ${chatwootId} SALVO no Redis com TTL de ${TTL_SECONDS}s.`);
    } catch (err) {
        currentLogger.error({ err }, `[Redis Map] Erro ao tentar SALVAR mapeamento ${baileysId} no Redis.`);
    }
}

async function getChatwootIdFromBaileysId(baileysId, currentLogger) { 
    if (!redisClientForMap || !redisClientForMap.isOpen) {
        currentLogger.warn(`[Redis Map] Cliente Redis NÃO ESTÁ CONECTADO para buscar mapeamento ${baileysId}. Retornando null.`);
        return null;
    }
    const key = `${config.REDIS_MAP_KEY_PREFIX || 'baileys_chatwoot_msg_map:'}${baileysId}`;
    try {
        const chatwootId = await redisClientForMap.get(key);
        if (chatwootId) {
            currentLogger.debug(`[Redis Map] Encontrado Chatwoot ID ${chatwootId} para Baileys ID ${baileysId} no Redis.`);
            return parseInt(chatwootId, 10);
        }
        currentLogger.debug(`[Redis Map] Mapeamento NÃO encontrado para Baileys ID ${baileysId} no Redis.`); 
        return null;
    } catch (err) {
        currentLogger.error({ err }, `[Redis Map] Erro ao tentar BUSCAR mapeamento ${baileysId} no Redis.`);
        return null;
    }
}

function setRedisClientForMap(client) {
    redisClientForMap = client;
    defaultLogger.info('[Redis Map] Cliente Redis para mapeamento de IDs INJETADO no manipulador.');
}

function getChatwootAxiosInstance(relayConfig, logger = defaultLogger) {
    const { CHATWOOT_BASE_URL, CHATWOOT_ACCOUNT_ID, CHATWOOT_API_ACCESS_TOKEN, CHATWOOT_API_TIMEOUT } = relayConfig;
    if (!CHATWOOT_BASE_URL || !CHATWOOT_ACCOUNT_ID || !CHATWOOT_API_ACCESS_TOKEN) {
        logger.error("[CW Axios] Configurações Chatwoot incompletas para instância Axios. BaseURL, AccountID, e Token são obrigatórios.");
        throw new Error("Configurações Chatwoot incompletas para instância Axios.");
    }
    const axiosBaseURL = `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}`;
    const instance = axios.create({
        baseURL: axiosBaseURL,
        timeout: CHATWOOT_API_TIMEOUT || 15000,
        headers: { 'api_access_token': relayConfig.CHATWOOT_API_ACCESS_TOKEN }
    });
    logger.debug(`[CW Axios] Instância Axios criada para: ${axiosBaseURL}`);
    return instance;
}

async function findOrCreateContact(axiosInstance, identifier, name, phoneNumber, relayChatwootInboxId, avatarUrl = null, isGroup = false, logger = defaultLogger) {
    const logPrefix = `[CW Contact - Inbox ${relayChatwootInboxId}]`;
    logger.info(`${logPrefix} Buscando/Criando contato: identifier="${identifier}", name="${name}", phone="${phoneNumber}", isGroup=${isGroup}`);
    
    try {
        const searchParams = new URLSearchParams({ q: identifier });
        const searchResponse = await axiosInstance.get(`/contacts/search?${searchParams.toString()}`);

        if (searchResponse.data?.payload?.length > 0) {
            const foundContact = searchResponse.data.payload[0];
            logger.info(`${logPrefix} Contato ENCONTRADO. ID: ${foundContact.id}, Nome Atual: ${foundContact.name}`);
            
            const updates = {};
            const hasNewValidName = name && name !== identifier;
            const isCurrentNameGeneric = foundContact.name && (foundContact.name.startsWith('WhatsApp ') || foundContact.name === foundContact.identifier);

            if (hasNewValidName && (isCurrentNameGeneric || name !== foundContact.name)) {
                updates.name = name;
            }
            if (avatarUrl && avatarUrl !== foundContact.avatar_url) {
                updates.avatar_url = avatarUrl;
            }
            if (phoneNumber && !foundContact.phone_number && !isGroup) {
                updates.phone_number = phoneNumber;
            }

            if (Object.keys(updates).length > 0) {
                logger.info(`${logPrefix} Atualizando contato ID ${foundContact.id} com: %o`, updates);
                await axiosInstance.put(`/contacts/${foundContact.id}`, updates);
            }
            return foundContact.id;
        } else {
            logger.info(`${logPrefix} Contato não encontrado. Criando novo...`);
            const nameForCreation = name || (isGroup ? `Grupo ${identifier}` : `WhatsApp ${identifier}`);
            const contactPayload = {
                inbox_id: parseInt(relayChatwootInboxId),
                name: nameForCreation,
                identifier: identifier,
                avatar_url: avatarUrl
            };
            if (!isGroup && phoneNumber) {
                contactPayload.phone_number = phoneNumber;
            }
            const contactResponse = await axiosInstance.post('/contacts', contactPayload);
            const createdContact = contactResponse.data.payload.contact || contactResponse.data.payload || contactResponse.data;
            logger.info(`${logPrefix} Novo contato CRIADO. ID: ${createdContact.id}, Nome: ${createdContact.name}`);
            return createdContact.id;
        }
    } catch (error) {
        logger.error({ err: error, responseData: error.response?.data, requestConfig: error.config }, `${logPrefix} ERRO ao buscar/criar contato para identifier "${identifier}"`);
        throw error;
    }
}

async function findOrCreateConversation(axiosInstance, contactId, sourceId, relayChatwootInboxId, logger = defaultLogger) {
    const logPrefix = `[CW Conversation - Inbox ${relayChatwootInboxId}]`;
    logger.info(`${logPrefix} Buscando/Criando conversa para contact_id: ${contactId}, source_id (JID): ${sourceId}`);
    try {
        const response = await axiosInstance.get(`/contacts/${contactId}/conversations`);
        if (response.data?.payload) {
            const relevantConversations = response.data.payload.filter(conv => conv.inbox_id === parseInt(relayChatwootInboxId));
            if (relevantConversations.length > 0) {
                const sortedConversations = relevantConversations.sort((a, b) => {
                    if (a.status === 'open' && b.status !== 'open') return -1;
                    if (b.status === 'open' && a.status !== 'open') return 1;
                    return new Date(b.contact_last_activity_at || b.created_at) - new Date(a.contact_last_activity_at || a.created_at);
                });
                const conversation = sortedConversations[0];
                logger.info(`${logPrefix} Conversa existente ENCONTRADA (ID: ${conversation.id}, Status: ${conversation.status}) para contact_id ${contactId} no inbox ${relayChatwootInboxId}.`);
                return conversation.id;
            }
        }
        logger.info(`${logPrefix} Nenhuma conversa encontrada para contact_id ${contactId} no inbox ${relayChatwootInboxId}. Criando nova...`);
        const createConversationPayload = { inbox_id: parseInt(relayChatwootInboxId), contact_id: contactId, source_id: sourceId };
        const createResponse = await axiosInstance.post('/conversations', createConversationPayload);
        const createdConversation = createResponse.data.id ? createResponse.data : createResponse.data.payload;
        logger.info(`${logPrefix} Nova conversa CRIADA. ID: ${createdConversation.id}`);
        return createdConversation.id;
    } catch (error) {
        logger.error({ err: error, responseData: error.response?.data, requestConfig: error.config }, `${logPrefix} ERRO ao buscar/criar conversa para contact_id "${contactId}"`);
        throw error;
    }
}

// *** ALTERAÇÃO AQUI: A função agora aceita 'contentAttributes' ***
async function processAndRelayMessageToChatwoot(baileysMessageDetailsInput, relayConfig, logger = defaultLogger, contentAttributes = {}) {
    // Corrige o buffer que vem serializado do Redis/BullMQ
    const baileysMessageDetails = JSON.parse(JSON.stringify(baileysMessageDetailsInput));
    if (baileysMessageDetails.mediaBuffer && baileysMessageDetails.mediaBuffer.type === 'Buffer' && Array.isArray(baileysMessageDetails.mediaBuffer.data)) {
        baileysMessageDetails.mediaBuffer = Buffer.from(baileysMessageDetails.mediaBuffer.data);
    }

    const {
        chatPartnerJid, contactPushName, isFromMe, mediaType, mediaMimetype,
        mediaFileName, avatarUrl, isGroup, messageIdBaileys
    } = baileysMessageDetails;
    let currentIsMedia = baileysMessageDetails.isMedia;
    let currentTextContent = baileysMessageDetails.textContent;

    const { CHATWOOT_INBOX_ID: relayChatwootInboxId } = relayConfig;
    const handlerLogger = logger.child({ 
        module: 'ChatwootHandler', baileysMsgId: messageIdBaileys,
        chatPartnerJid, relayToInbox: relayChatwootInboxId
    });
    
    const logPrefix = `[CW Relay - Inbox ${relayChatwootInboxId} - ${isFromMe ? 'OUT(FromMe)' : 'IN'} from ${chatPartnerJid}]`;
    handlerLogger.info(`${logPrefix} Iniciando processamento. isMedia=${currentIsMedia}, textContent (primeiros 50): "${currentTextContent?.substring(0, 50)}..."`);
    
    if (!currentTextContent && !currentIsMedia) {
        handlerLogger.warn(`${logPrefix} Mensagem sem texto ou flag de mídia. Ignorando.`);
        return;
    }
    
    let axiosInstance = getChatwootAxiosInstance(relayConfig, handlerLogger);
    const chatwootContactIdentifier = isGroup ? chatPartnerJid : chatPartnerJid.split('@')[0];
    const chatwootPhoneNumber = !isGroup && /^\d+$/.test(chatwootContactIdentifier) ? `+${chatwootContactIdentifier}` : null;

    try {
        const contactId = await findOrCreateContact(axiosInstance, chatwootContactIdentifier, contactPushName, chatwootPhoneNumber, relayChatwootInboxId, avatarUrl, isGroup, handlerLogger);
        const conversationId = await findOrCreateConversation(axiosInstance, contactId, chatPartnerJid, relayChatwootInboxId, handlerLogger);

        handlerLogger.info(`${logPrefix} Adicionando mensagem à conversa ID Chatwoot: ${conversationId}`);
        const messageEndpoint = `/conversations/${conversationId}/messages`;
        
        const sourceIdForChatwoot = isFromMe ? `ponte_echo_${messageIdBaileys}` : messageIdBaileys;
        
        // 'contentAttributes' agora vem como parâmetro e será usado diretamente
        handlerLogger.debug({ contentAttributes }, "Atributos de conteúdo recebidos para envio.");

        let response;
        if (currentIsMedia && baileysMessageDetails.mediaBuffer?.length > 0) {
            const formData = new FormData();
            formData.append('content', currentTextContent || '');
            formData.append('message_type', isFromMe ? 'outgoing' : 'incoming');
            formData.append('private', 'false');
            if (sourceIdForChatwoot) formData.append('source_id', sourceIdForChatwoot);
            if (Object.keys(contentAttributes).length > 0) formData.append('content_attributes', JSON.stringify(contentAttributes));
            
            formData.append('attachments[]', baileysMessageDetails.mediaBuffer, {
                filename: mediaFileName || `${mediaType}_${Date.now()}.${mediaMimetype ? mediaMimetype.split('/')[1] || 'bin' : 'bin'}`,
                contentType: mediaMimetype || 'application/octet-stream',
            });
            response = await axiosInstance.post(messageEndpoint, formData, { headers: formData.getHeaders() });
        } else {
            const textMessagePayload = {
                content: currentTextContent,
                message_type: isFromMe ? 'outgoing' : 'incoming',
                private: false,
                source_id: sourceIdForChatwoot,
            };
            if (Object.keys(contentAttributes).length > 0) { 
                textMessagePayload.content_attributes = contentAttributes;
            }
            response = await axiosInstance.post(messageEndpoint, textMessagePayload);
        }
        
        const chatwootMessageIdResponse = response.data?.id || response.data?.payload?.id;
        if (messageIdBaileys && chatwootMessageIdResponse) {
            await setBaileysIdToChatwootId(messageIdBaileys, chatwootMessageIdResponse, handlerLogger);
        }

        handlerLogger.info(`${logPrefix} Mensagem adicionada à conversa ID: ${conversationId} com sucesso!`);

    } catch (error) {
        handlerLogger.error({
            err: error, message: error.message,
            config: error.config ? { url: error.config.url, method: error.config.method } : undefined,
            response: error.response ? { status: error.response.status, data: error.response.data } : undefined
        }, `${logPrefix} ERRO GERAL ao interagir com a API do Chatwoot`);
        throw error;
    }
}

module.exports = {
    processAndRelayMessageToChatwoot,
    getChatwootAxiosInstance,
    findOrCreateContact,
    findOrCreateConversation,
    setRedisClientForMap 
};
