# Ponte Baileys-Chatwoot

Um sistema robusto de ponte que conecta o WhatsApp (via Baileys) com o Chatwoot, permitindo uma integração perfeita entre mensagens do WhatsApp e a plataforma de atendimento ao cliente Chatwoot. Este sistema suporta múltiplas instâncias do WhatsApp e fornece uma arquitetura escalável para o gerenciamento de mensagens.

## Funcionalidades

- 🔄 Suporte a múltiplas instâncias do WhatsApp
- 📱 Relé de mensagens entre WhatsApp e Chatwoot
- 🔒 Gerenciamento seguro de sessões
- 📊 Monitoramento em tempo real
- 🔄 Reconexão automática
- 📝 Suporte a vários tipos de mensagens (texto, mídia, documentos)
- 🔐 Sistema de autenticação via QR Code
- 🚀 Arquitetura escalável baseada em workers
- 📈 Processamento de mensagens via fila
- 🔍 Sistema detalhado de logs

## Pré-requisitos

- Node.js >= 18.0.0
- Servidor Redis
- Instância do Chatwoot
- Conta(s) do WhatsApp

## Instalação

1. Clone o repositório:
```bash
git clone <url-do-repositorio>
cd baileys-chatwoot-ponte
```

2. Instale as dependências:
```bash
npm install
```

3. Crie um arquivo `.env` com as seguintes configurações:
```env
# Configurações do Servidor
SERVER_PORT=3001
SERVER_LOG_LEVEL=info
MAX_WORKERS=0  # 0 para detecção automática

# Configurações do Baileys
BAILEYS_AUTH_SESSIONS_PARENT_DIR=automation_auth_sessions
BAILEYS_BROWSER_NAME=ChatwootDynamicBridge
BAILEYS_LOG_LEVEL_INSTANCE=warn
BAILEYS_RECONNECT_DELAY_MS=10000
BAILEYS_MAX_QR_SEND_ATTEMPTS=4

# Configurações do Chatwoot
CHATWOOT_BASE_URL=http://seu-chatwoot-url
CHATWOOT_API_ACCESS_TOKEN=seu-token-de-api
CHATWOOT_API_TIMEOUT=15000
DEFAULT_CHATWOOT_ACCOUNT_ID=1
DEFAULT_RELAY_CHATWOOT_INBOX_ID=0

# Configurações do Webhook de Comando
WEBHOOK_COMMAND_KEYWORD=erga
WEBHOOK_AUTHORIZED_PHONE_NUMBERS=+5585999999999

# Configurações do Redis
REDIS_URL=redis://localhost:6379
REDIS_USER=opcional
REDIS_PASSWORD=opcional

# Configurações da Fila
CHATWOOT_QUEUE_WORKER_LOG_LEVEL=info
CHATWOOT_QUEUE_CONCURRENCY=5
BULLMQ_JOB_ATTEMPTS=3
BULLMQ_JOB_BACKOFF_DELAY=5000
```

## Uso

### Iniciando o Servidor

Modo desenvolvimento:
```bash
npm run dev
```

Modo produção:
```bash
npm run start-prod
```

### Gerenciando Instâncias do WhatsApp

O sistema fornece um endpoint webhook para gerenciar instâncias do WhatsApp. Envie uma requisição POST para `/webhook/comando` com o seguinte formato:

```json
{
  "message_type": "incoming",
  "event": "message_created",
  "content": "erga [id_da_caixa] [id_da_conta]",
  "sender": {
    "phone_number": "+5585999999999"
  },
  "inbox": {
    "id": "1",
    "name": "Caixa de Entrada WhatsApp"
  },
  "conversation": {
    "id": "123",
    "meta": {
      "sender": {
        "phone_number": "+5585999999999"
      }
    }
  },
  "account": {
    "id": "1"
  }
}
```

### Monitoramento

Acesse o painel de status global:
```bash
./dashboard.sh
```

Ou faça uma requisição GET para o endpoint `/global-status` para obter o status atual de todas as instâncias.

## Arquitetura

### Componentes

1. **Processo Primário**
   - Gerencia processos workers
   - Controla distribuição de instâncias
   - Fornece endpoint de status global

2. **Processos Workers**
   - Gerencia instâncias do WhatsApp
   - Processa mensagens
   - Mantém conexões WebSocket

3. **Sistema de Fila**
   - Processa mensagens de forma assíncrona
   - Garante entrega confiável de mensagens
   - Gerencia tentativas e falhas

### Fluxo de Mensagens

1. Mensagem do WhatsApp recebida → Baileys
2. Mensagem analisada e processada
3. Adicionada à fila Redis
4. Worker da fila processa a mensagem
5. Mensagem enviada ao Chatwoot

## Segurança

- Dados de sessão armazenados com segurança
- Tokens de API necessários para integração com Chatwoot
- Autorização por número de telefone para comandos
- Conexões WebSocket seguras

## Logs

O sistema utiliza Pino para logs com diferentes níveis:
- `info`: Informações operacionais gerais
- `warn`: Mensagens de aviso
- `error`: Condições de erro
- `debug`: Informações detalhadas de depuração

## Contribuindo

1. Faça um fork do repositório
2. Crie sua branch de feature
3. Faça commit das suas alterações
4. Envie para a branch
5. Crie um Pull Request
