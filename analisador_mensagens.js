// analisador_mensagens.js
const { downloadMediaMessage, getContentType } = require('@whiskeysockets/baileys'); // Ou @whiskeysockets/baileys
const P = require('pino'); // Para o logger, se necessário dentro desta função

// Um logger simples para esta função, pode ser configurado externamente se desejar
const localLogger = P({ level: process.env.ANALISADOR_LOG_LEVEL || 'warn' }).child({ component: 'AnalisadorMensagens' });

/**
 * Analisa o conteúdo da mensagem Baileys para extrair texto, mídia e outros detalhes.
 * @param {object} baileysMessageObjectContainer - O objeto 'msg' completo do Baileys (geralmente m.messages[0]).
 * @param {object} sockInstance - A instância do socket Baileys, necessária para reupload de mídia.
 * @param {object} [logger=localLogger] - Instância de logger Pino opcional.
 * @returns {Promise<object|null>} Um objeto com detalhes da mensagem ou null se for para ignorar.
 */
async function parseBaileysMessageContent(baileysMessageObjectContainer, sockInstance, logger = localLogger) {
    // =================================================================
    // MODIFICAÇÃO INICIA AQUI
    // Verificamos se a mensagem principal é do tipo efêmera.
    // =================================================================
    let messageObject = baileysMessageObjectContainer.message;
    if (messageObject && messageObject.ephemeralMessage) {
        logger.debug('[Analisador] Mensagem efêmera detectada. Desembrulhando...');
        // Substituímos o objeto da mensagem pelo conteúdo real que está dentro dela.
        // E guardamos as informações originais da mensagem efêmera para contexto.
        const originalKey = baileysMessageObjectContainer.key;
        const originalTimestamp = baileysMessageObjectContainer.messageTimestamp;
        
        baileysMessageObjectContainer = {
            key: originalKey,
            message: messageObject.ephemeralMessage.message,
            messageTimestamp: originalTimestamp,
            pushName: baileysMessageObjectContainer.pushName
        };
        // Atualizamos messageObject para apontar para a mensagem desembrulhada.
        messageObject = baileysMessageObjectContainer.message;
    }
    // =================================================================
    // FIM DA MODIFICAÇÃO - O resto do código agora opera na mensagem correta
    // =================================================================

    if (!messageObject) {
        logger.warn('[Analisador] Objeto de mensagem ausente em baileysMessageObjectContainer.');
        return null;
    }

    let details = {
        isMedia: false,
        textContent: '',
        mediaType: null,
        mediaBuffer: null,
        mediaMimetype: null,
        mediaFileName: null,
        mediaCaption: '', // Legenda original associada à mídia
        isReply: false,
        quotedMsgId: null,
        quotedMsgText: null,
        quotedMsgParticipant: null, // Quem enviou a msg citada (JID)
        extraMediaInfo: {}, // Para informações adicionais como isGif, isPTT, duration, isAnimatedSticker
    };

    let messageTypeForLog = getContentType(messageObject) || 'desconhecido';

    // --- Checar se é uma Resposta (Quote) ---
    // Acessa contextInfo de forma segura, independentemente do tipo de mensagem principal
    let contextInfo = null;
    if (messageObject.extendedTextMessage) contextInfo = messageObject.extendedTextMessage.contextInfo;
    else if (messageObject.imageMessage) contextInfo = messageObject.imageMessage.contextInfo;
    else if (messageObject.videoMessage) contextInfo = messageObject.videoMessage.contextInfo;
    else if (messageObject.audioMessage) contextInfo = messageObject.audioMessage.contextInfo;
    else if (messageObject.documentMessage) contextInfo = messageObject.documentMessage.contextInfo;
    else if (messageObject.stickerMessage) contextInfo = messageObject.stickerMessage.contextInfo;
    // Adicionar outros tipos que podem ter contextInfo aqui, se necessário

    if (contextInfo && contextInfo.quotedMessage) {
        details.isReply = true;
        details.quotedMsgId = contextInfo.stanzaId;
        details.quotedMsgParticipant = contextInfo.participant; // JID de quem enviou a msg original

        const quotedMsg = contextInfo.quotedMessage;
        if (quotedMsg.conversation) {
            details.quotedMsgText = quotedMsg.conversation;
        } else if (quotedMsg.extendedTextMessage) {
            details.quotedMsgText = quotedMsg.extendedTextMessage.text;
        } else if (quotedMsg.imageMessage) {
            details.quotedMsgText = quotedMsg.imageMessage.caption || "[Imagem citada]";
        } else if (quotedMsg.videoMessage) {
            details.quotedMsgText = quotedMsg.videoMessage.caption || "[Vídeo citado]";
        } else if (quotedMsg.audioMessage) {
            details.quotedMsgText = "[Áudio citado]";
        } else if (quotedMsg.stickerMessage) {
            details.quotedMsgText = "[Sticker citado]";
        } else if (quotedMsg.documentMessage) {
            details.quotedMsgText = `[Documento citado: ${quotedMsg.documentMessage.fileName || 'arquivo'}]`;
        } else {
            details.quotedMsgText = "[Mensagem citada de tipo não reconhecido]";
        }
        logger.debug(`[Analisador] Mensagem é uma resposta. Citando ID: ${details.quotedMsgId}, Texto: ${details.quotedMsgText?.substring(0,30)}`);
    }


    // --- Extração de Conteúdo Principal ---
    if (messageObject.conversation) {
        details.textContent = messageObject.conversation;
        messageTypeForLog = 'conversation';
    } else if (messageObject.extendedTextMessage) {
        details.textContent = messageObject.extendedTextMessage.text || '';
        messageTypeForLog = 'extendedTextMessage';
    } else if (messageObject.imageMessage) {
        messageTypeForLog = 'imageMessage';
        details.isMedia = true;
        details.mediaType = 'image';
        details.mediaCaption = messageObject.imageMessage.caption || '';
        details.textContent = details.mediaCaption; // textContent será a legenda
        details.mediaMimetype = messageObject.imageMessage.mimetype || 'image/jpeg';
        const extensionImg = details.mediaMimetype.split('/')[1] || 'jpg';
        details.mediaFileName = messageObject.imageMessage.fileName || `imagem-${Date.now()}.${extensionImg}`;
        details.extraMediaInfo.isGif = messageObject.imageMessage.gifPlayback || false;
        try {
            logger.debug(`[Analisador] Baixando imagem: ${details.mediaFileName}`);
            details.mediaBuffer = await downloadMediaMessage(baileysMessageObjectContainer, 'buffer', {}, { logger, reuploadRequest: sockInstance.updateMediaMessage });
            logger.debug(`[Analisador] Imagem baixada. Buffer existe: ${!!details.mediaBuffer}, Tamanho: ${details.mediaBuffer?.length}`);
        } catch (dlError) {
            logger.error({ err: dlError }, `[Analisador ERROR] Falha ao baixar imagem: ${details.mediaFileName}`);
            details.isMedia = false;
            details.mediaBuffer = null;
            details.textContent = details.mediaCaption ? `[Falha ao baixar Imagem: ${details.mediaFileName}] ${details.mediaCaption}`.trim() : `[Falha ao baixar Imagem: ${details.mediaFileName}]`;
        }
    } else if (messageObject.audioMessage) {
        messageTypeForLog = 'audioMessage';
        details.isMedia = true;
        details.mediaType = 'audio';
        details.mediaCaption = ''; // Áudios não têm legenda no WhatsApp
        details.textContent = ''; // Não há textContent para áudios em si, apenas o anexo
        details.mediaMimetype = messageObject.audioMessage.mimetype || 'audio/ogg';
        const extensionAudio = details.mediaMimetype.includes('mp4') ? 'm4a' : (details.mediaMimetype.split('/')[1] || 'ogg');
        details.mediaFileName = `audio-${Date.now()}.${extensionAudio}`;
        details.extraMediaInfo.isPTT = messageObject.audioMessage.ptt || false;
        details.extraMediaInfo.duration = messageObject.audioMessage.seconds || 0;
        try {
            logger.debug(`[Analisador] Baixando áudio: ${details.mediaFileName}`);
            details.mediaBuffer = await downloadMediaMessage(baileysMessageObjectContainer, 'buffer', {}, { logger, reuploadRequest: sockInstance.updateMediaMessage });
            logger.debug(`[Analisador] Áudio baixado. Buffer existe: ${!!details.mediaBuffer}, Tamanho: ${details.mediaBuffer?.length}`);
        } catch (dlError) {
            logger.error({ err: dlError }, `[Analisador ERROR] Falha ao baixar áudio: ${details.mediaFileName}`);
            details.isMedia = false;
            details.mediaBuffer = null;
            details.textContent = `[Falha ao baixar ${details.extraMediaInfo.isPTT ? "Mensagem de voz" : "Áudio"}: ${details.mediaFileName}]`;
        }
    } else if (messageObject.videoMessage) {
        messageTypeForLog = 'videoMessage';
        details.isMedia = true;
        details.mediaType = 'video';
        details.mediaCaption = messageObject.videoMessage.caption || '';
        details.textContent = details.mediaCaption; // textContent será a legenda
        details.mediaMimetype = messageObject.videoMessage.mimetype || 'video/mp4';
        const extensionVideo = details.mediaMimetype.split('/')[1] || 'mp4';
        details.mediaFileName = messageObject.videoMessage.fileName || `video-${Date.now()}.${extensionVideo}`;
        details.extraMediaInfo.isGif = messageObject.videoMessage.gifPlayback || false;
        details.extraMediaInfo.duration = messageObject.videoMessage.seconds || 0;
        try {
            logger.debug(`[Analisador] Baixando vídeo: ${details.mediaFileName}`);
            details.mediaBuffer = await downloadMediaMessage(baileysMessageObjectContainer, 'buffer', {}, { logger, reuploadRequest: sockInstance.updateMediaMessage });
            logger.debug(`[Analisador] Vídeo baixado. Buffer existe: ${!!details.mediaBuffer}, Tamanho: ${details.mediaBuffer?.length}`);
        } catch (dlError) {
            logger.error({ err: dlError }, `[Analisador ERROR] Falha ao baixar vídeo: ${details.mediaFileName}`);
            details.isMedia = false;
            details.mediaBuffer = null;
            details.textContent = details.mediaCaption ? `[Falha ao baixar Vídeo: ${details.mediaFileName}] ${details.mediaCaption}`.trim() : `[Falha ao baixar Vídeo: ${details.mediaFileName}]`;
        }
    } else if (messageObject.documentMessage) {
        messageTypeForLog = 'documentMessage';
        details.isMedia = true;
        details.mediaType = 'document';
        details.mediaFileName = messageObject.documentMessage.fileName || "documento_desconhecido";
        details.mediaCaption = messageObject.documentMessage.caption || '';
        details.textContent = details.mediaCaption; // textContent será a legenda
        details.mediaMimetype = messageObject.documentMessage.mimetype || 'application/octet-stream';
        try {
            logger.debug(`[Analisador] Baixando documento: ${details.mediaFileName}`);
            details.mediaBuffer = await downloadMediaMessage(baileysMessageObjectContainer, 'buffer', {}, { logger, reuploadRequest: sockInstance.updateMediaMessage });
            logger.debug(`[Analisador] Documento baixado. Buffer existe: ${!!details.mediaBuffer}, Tamanho: ${details.mediaBuffer?.length}`);
        } catch (dlError) {
            logger.error({ err: dlError }, `[Analisador ERROR] Falha ao baixar documento: ${details.mediaFileName}`);
            details.isMedia = false;
            details.mediaBuffer = null;
            details.textContent = details.mediaCaption ? `[Falha ao baixar Documento: ${details.mediaFileName}] ${details.mediaCaption}`.trim() : `[Falha ao baixar Documento: ${details.mediaFileName}]`;
        }
    } else if (messageObject.stickerMessage) { // MODIFICAÇÃO PARA STICKERS
        messageTypeForLog = 'stickerMessage';
        details.isMedia = true;
        details.mediaType = 'sticker'; // Será tratado como 'image' pelo Chatwoot, mas ajuda a identificar internamente
        details.mediaCaption = ''; // Stickers não têm legenda
        details.textContent = '';   // Enviar como anexo sem texto principal
        details.mediaMimetype = messageObject.stickerMessage.mimetype || 'image/webp';
        details.mediaFileName = `sticker-${baileysMessageObjectContainer.key.id?.substring(0,10) || Date.now()}.webp`;
        details.extraMediaInfo.isAnimatedSticker = messageObject.stickerMessage.isAnimated || false;
        try {
            logger.debug(`[Analisador] Baixando sticker: ${details.mediaFileName}, Animado: ${details.extraMediaInfo.isAnimatedSticker}`);
            details.mediaBuffer = await downloadMediaMessage(baileysMessageObjectContainer, 'buffer', {}, { logger, reuploadRequest: sockInstance.updateMediaMessage });
            logger.debug(`[Analisador] Sticker baixado. Buffer existe: ${!!details.mediaBuffer}, Tamanho: ${details.mediaBuffer?.length}`);
        } catch (dlError) {
            logger.error({ err: dlError }, `[Analisador ERROR] Falha ao baixar sticker: ${details.mediaFileName}`);
            details.isMedia = false;
            details.mediaBuffer = null;
            details.textContent = `[Falha ao baixar Sticker: ${details.mediaFileName}]`;
        }
    } else if (messageObject.contactMessage) {
        messageTypeForLog = 'contactMessage';
        const vcard = messageObject.contactMessage.vcard;
        const contactName = messageObject.contactMessage.displayName;
        if (vcard && typeof vcard === 'string') {
            const lines = vcard.split('\n');
            let formattedVcard = `Contato compartilhado: ${contactName || ''}\n`;
            let phoneNumbers = [];
            lines.forEach(line => {
                if (line.startsWith('FN:')) { // Full Name
                    if (!contactName) formattedVcard += `Nome: ${line.substring(3)}\n`;
                } else if (line.startsWith('TEL;')) {
                    const parts = line.split(':');
                    if (parts.length > 1) phoneNumbers.push(parts[1]);
                }
            });
            if (phoneNumbers.length > 0) {
                formattedVcard += `Telefone(s): ${phoneNumbers.join(', ')}\n`;
            }
            details.textContent = formattedVcard.trim();
        } else {
            details.textContent = `[Contato compartilhado: ${contactName || 'Nome não disponível'}]`;
        }
        logger.debug('[Analisador] Mensagem de contato parseada.');
    } else if (messageObject.locationMessage) {
        messageTypeForLog = 'locationMessage';
        const lat = messageObject.locationMessage.degreesLatitude;
        const long = messageObject.locationMessage.degreesLongitude;
        const name = messageObject.locationMessage.name;
        const address = messageObject.locationMessage.address;
        details.textContent = `Localização: ${name ? name + ' - ' : ''}${address || ''}\nMapa: https://maps.google.com/?q=${lat},${long}`;
        logger.debug('[Analisador] Mensagem de localização parseada.');
    }
    // Adicionar aqui outros tipos de mensagem se necessário (ex: listMessage, buttonsMessage, etc.)
    // ...
    else {
        // Para mensagens não explicitamente tratadas ou que são apenas eventos (ex: reactionMessage)
        const ignoredTypes = ['protocolMessage', 'senderKeyDistributionMessage', 'reactionMessage', 'pollCreationMessage', 'pollUpdateMessage', 'editedMessage'];
        if (messageTypeForLog && ignoredTypes.includes(messageTypeForLog)) {
            logger.debug(`[Analisador] Mensagem de tipo '${messageTypeForLog}' ignorada por padrão.`);
            return null; // Sinaliza para ignorar esta mensagem
        }
        // Se o tipo não for conhecido e não estiver na lista de ignorados, pode logar e tentar pegar um texto genérico
        if (Object.keys(messageObject).length > 0 && !details.textContent && !details.isMedia) {
             logger.warn({ messageTypeForLog, keys: Object.keys(messageObject) }, '[Analisador] Tipo de mensagem Baileys não parseado para texto ou mídia, mas não está na lista de ignorados.');
             details.textContent = `[Mensagem de tipo não diretamente suportado: ${messageTypeForLog}]`;
        } else if (Object.keys(messageObject).length === 0) {
            logger.debug('[Analisador] Mensagem vazia ou de notificação (sem messageObject keys). Ignorando.');
            return null;
        }
    }

    // Sanitizar textContent para evitar problemas com o Chatwoot ou caracteres nulos
    if (typeof details.textContent === 'string') {
        details.textContent = details.textContent.replace(/\u0000/g, ''); // Remove null characters
    } else if (details.textContent == null) { // Trata null ou undefined
        details.textContent = '';
    }
    
    // Se, após todo o parse, não houver conteúdo textual E não for mídia com buffer, ignorar.
    // (Exceto se for um sticker que falhou o download mas ainda queremos registrar o placeholder)
    if (!details.textContent && !(details.isMedia && details.mediaBuffer) && details.mediaType !== 'sticker') {
        logger.info({ messageTypeForLog, msgId: baileysMessageObjectContainer.key.id }, '[Analisador] Mensagem sem conteúdo textual ou mídia válida após parse. Ignorando.');
        return null;
    }


    logger.debug({
        msgId: baileysMessageObjectContainer.key.id,
        type: messageTypeForLog,
        textContentPreview: details.textContent ? details.textContent.substring(0, 30) : 'N/A',
        isMedia: details.isMedia,
        mediaType: details.mediaType,
        hasBuffer: !!details.mediaBuffer
    },'[Analisador] Detalhes finais parseados.');

    return details;
}

module.exports = {
    parseBaileysMessageContent
};
