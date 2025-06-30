# Documentação Técnica: Integração WhatsApp (Baileys) e Chatwoot

## 1. Visão Geral da Arquitetura

Este documento detalha a arquitetura e o funcionamento da aplicação de ponte (bridge) entre o WhatsApp, utilizando a biblioteca Baileys, e a plataforma de atendimento ao cliente Chatwoot. O objetivo do sistema é permitir uma comunicação bidirecional, onde mensagens do WhatsApp são exibidas no Chatwoot e respostas dos agentes no Chatwoot são enviadas ao WhatsApp.

A arquitetura é baseada em micro-serviços Node.js e utiliza um sistema de filas para garantir resiliência e processamento assíncrono.

### 1.1. Principais Componentes

O projeto é dividido nos seguintes serviços e módulos principais:

* **`ponte_server.js` (O Servidor Principal):** O coração da aplicação. Gerencia as conexões com o WhatsApp (instâncias Baileys) em um cluster Node.js, recebe comandos e delega o envio de mensagens.
* **`analisador_mensagens.js` (O Parser de Mensagens):** Módulo responsável por traduzir os objetos de mensagem brutos do Baileys para um formato estruturado e padronizado.
* **Fila de Mensagens (BullMQ + Redis):** Um sistema de filas que desacopla o recebimento de mensagens do WhatsApp do envio para o Chatwoot, garantindo que nenhuma mensagem seja perdida em caso de falha da API do Chatwoot.
* **`chatwoot_queue_worker.js` (O Worker da Fila):** Um processo que consome os trabalhos da fila de mensagens. Sua única função é pegar uma mensagem processada e entregá-la ao manipulador.
* **`chatwoot_manipulador_aprimorado.js` (O Manipulador Chatwoot):** Contém toda a lógica de negócio para interagir com a API do Chatwoot (criar contatos, encontrar conversas, enviar mensagens de texto e mídia, etc.).
* **`chatwoot_sender.js` (O Receptor de Webhooks):** Um serviço Express independente que escuta por webhooks do Chatwoot, acionado quando um agente envia uma mensagem.

### 1.2. Fluxo de Dados

#### Fluxo 1: WhatsApp para Chatwoot


[WhatsApp] -> [Baileys Lib] -> [ponte_server.js] -> [analisador_mensagens.js] -> [Fila BullMQ/Redis] -> [chatwoot_queue_worker.js] -> [chatwoot_manipulador_aprimorado.js] -> [API do Chatwoot] -> [Dashboard do Agente]


1.  Uma mensagem é recebida do WhatsApp pela instância Baileys em um dos workers do `ponte_server.js`.
2.  O `ponte_server.js` passa a mensagem para o `analisador_mensagens.js`.
3.  O analisador baixa mídias (se houver), extrai texto, informações de citação e formata um objeto padronizado.
4.  O objeto é colocado como um "job" na fila do BullMQ no Redis.
5.  O `chatwoot_queue_worker.js` pega o job da fila.
6.  O worker invoca o `chatwoot_manipulador_aprimorado.js` com os dados do job.
7.  O manipulador executa a lógica de negócio: encontra/cria o contato e a conversa no Chatwoot e, por fim, posta a mensagem na conversa através da API do Chatwoot.
8.  A mensagem aparece no painel do agente no Chatwoot.

#### Fluxo 2: Chatwoot para WhatsApp


[Dashboard do Agente] -> [API do Chatwoot] -> [Webhook] -> [chatwoot_sender.js] -> [API Interna do ponte_server.js] -> [Worker Correto] -> [Baileys Lib] -> [WhatsApp]


1.  Um agente envia uma mensagem ou resposta no Chatwoot.
2.  O Chatwoot dispara um webhook do evento `message_created`.
3.  O serviço `chatwoot_sender.js` recebe este webhook.
4.  O `sender` extrai as informações relevantes (destinatário, conteúdo, anexos, etc.) e, se for uma resposta, busca os detalhes da mensagem original na API do Chatwoot para obter o ID da mensagem no WhatsApp.
5.  O `sender` faz uma chamada para uma API interna segura no processo primário do `ponte_server.js`.
6.  O processo primário identifica qual worker está gerenciando a instância de WhatsApp correspondente e encaminha a solicitação para ele via IPC (Comunicação Inter-Processos).
7.  O worker correto recebe a instrução, monta a mensagem no formato Baileys e a envia para o destinatário no WhatsApp.

## 2. Análise Detalhada dos Componentes

### 2.1. `ponte_server.js`

Este é o componente mais complexo, atuando como um orquestrador.

* **Arquitetura de Cluster:** Utiliza o módulo `cluster` do Node.js para criar um processo "primário" e múltiplos processos "workers". Isso permite distribuir a carga das conexões Baileys e aproveitar múltiplos núcleos de CPU.
    * **Processo Primário:** Não gerencia conexões Baileys diretamente. Suas responsabilidades são:
        * Criar e monitorar os workers.
        * Distribuir as instâncias entre os workers (load balancing).
        * Expor endpoints de gerenciamento (`/global-status`) e a API interna (`/internal-api/send-whatsapp`) para receber solicitações do `chatwoot_sender.js`.
        * Receber comandos via webhook e delegá-los ao worker apropriado.
    * **Processo Worker:** Cada worker pode gerenciar múltiplas instâncias Baileys. Suas responsabilidades são:
        * Manter a conexão WebSocket com o WhatsApp via `makeWASocket`.
        * Gerenciar o ciclo de vida da conexão: geração de QR Code, reconexão automática, tratamento de desconexão.
        * Escutar eventos de mensagens (`messages.upsert`).
        * Processar comandos recebidos do processo primário.

* **Funções e Eventos Chave:**
    * `startBaileysConnection()`: Função central que inicializa uma instância do Baileys, configura seus eventos e gerencia a autenticação através do `useMultiFileAuthState`.
    * `sock.ev.on('messages.upsert', ...)`: O coração do recebimento de mensagens. Ao receber uma mensagem, ele:
        1.  Verifica se a mensagem não é um "eco" de algo que a própria ponte enviou.
        2.  Chama o `analisador_mensagens.js` para parsear o conteúdo.
        3.  Se a mensagem é uma resposta, busca o ID da mensagem original no Redis para possibilitar a citação no Chatwoot.
        4.  Monta o `jobData` e o adiciona à fila do BullMQ.
    * `/webhook/comando`: Endpoint que escuta por comandos especiais enviados via Chatwoot (ex: `!erga`), permitindo que um administrador inicie ou reinicie uma conexão de uma instância específica.

### 2.2. `analisador_mensagens.js`

Um módulo utilitário focado em uma única tarefa: tradução.

* **Função Principal:** `parseBaileysMessageContent()`
* **Responsabilidade:** Recebe o objeto de mensagem complexo e muitas vezes aninhado do Baileys e o transforma em um objeto JavaScript simples e padronizado.
* **Funcionalidades:**
    * **Extração de Conteúdo:** Obtém o texto de diferentes tipos de mensagem (`conversation`, `extendedTextMessage`, legendas de mídia).
    * **Download de Mídia:** Para mensagens com mídia, utiliza `downloadMediaMessage` para obter o `Buffer` do arquivo.
    * **Tratamento de Citações:** Identifica se uma mensagem é uma resposta e extrai o ID e o conteúdo da mensagem original citada.
    * **Normalização:** Retorna um objeto consistente com campos como `isMedia`, `textContent`, `mediaType`, `mediaBuffer`, `isReply`, `quotedMsgId`, etc.

### 2.3. Sistema de Fila e Workers

* **`chatwoot_queue_worker.js`:** Atua como um "operário". Ele é inicializado pelo PM2 (ou outro gerenciador de processos) e fica ocioso, esperando por trabalhos na fila do Redis. Ao receber um trabalho, ele o passa para o `chatwoot_manipulador_aprimorado.js`. Sua simplicidade o torna robusto.
* **`chatwoot_manipulador_aprimorado.js`:** O cérebro da interação com o Chatwoot.
    * **Função Principal:** `processAndRelayMessageToChatwoot()`
    * **Etapas do Processamento:**
        1.  **Contato:** Chama `findOrCreateContact` para verificar se o contato do WhatsApp (identificado pelo JID) já existe no Chatwoot. Se não, cria um novo. Ele também atualiza o nome e o avatar do contato, se necessário.
        2.  **Conversa:** Após garantir a existência do contato, chama `findOrCreateConversation` para obter a conversa associada àquele contato na caixa de entrada correta.
        3.  **Envio da Mensagem:** Constrói a requisição para a API do Chatwoot. Se for texto, envia um payload JSON. Se for mídia, monta um `FormData` com o buffer do arquivo e o envia. É aqui que os `content_attributes` (com o `in_reply_to`) são adicionados para criar a citação.

### 2.4. `chatwoot_sender.js`

Serviço independente cuja única função é ser a porta de entrada para as ações iniciadas no Chatwoot.

* **Endpoint Principal:** `/webhook/chatwoot-to-whatsapp`
* **Lógica:**
    1.  Valida o webhook para garantir que é uma mensagem enviada por um agente (`message_type: 'outgoing'`, `sender.type: 'user'`).
    2.  Extrai o `phone_number` do destinatário do payload.
    3.  Se a mensagem no Chatwoot for uma resposta, ele usa a API do Chatwoot para buscar a mensagem original e extrair seu `source_id` (que é o ID da mensagem no Baileys, salvo anteriormente no Redis).
    4.  Monta um payload limpo e o envia para a API interna do `ponte_server.js`, delegando a tarefa de envio.

## 3. Persistência e Gerenciamento de Estado

* **Sessões Baileys:** As credenciais de autenticação de cada instância do WhatsApp são salvas em pastas separadas dentro de `./auth_sessions/`. Isso permite que o serviço seja reiniciado sem a necessidade de escanear o QR Code novamente, a menos que a sessão seja invalidada.
* **Redis:** É um componente crítico usado para duas finalidades:
    1.  **BullMQ:** Serve como backend para a fila de mensagens, persistindo os jobs até que sejam processados com sucesso.
    2.  **Mapeamento de IDs:** Atua como um banco de dados chave-valor de alta velocidade para mapear o `ID da mensagem do Baileys` para o `ID da mensagem do Chatwoot`. Esse mapeamento é a chave para o funcionamento da funcionalidade de citação/resposta em ambos os sentidos.

---
