#!/bin/bash

PRIMARY_MANAGEMENT_PORT=3101
SERVER_URL="http://localhost:${PRIMARY_MANAGEMENT_PORT}/global-status"

# Cores
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

echo -e "${CYAN}==================================================${NC}"
echo -e "${CYAN}   Dashboard de Status Global - Baileys Ponte    ${NC}"
echo -e "${CYAN}==================================================${NC}"

# Nota: statusDisplay é agora gerado no script localmente com base no campo 'status' do JSON.
# As cores aqui serão para os rótulos e para o lastError se não vier com cor.

curl -s "$SERVER_URL" | jq -r '
  .serverTime,
  .totalActiveInstances,
  .workersQueried,
  .workersResponded,
  (.instancesGlobal // []) # Garante que seja um array, mesmo que nulo
' | {
  read -r serverTime
  read -r totalActiveInstances
  read -r workersQueried
  read -r workersResponded

  echo -e "Horário do Servidor    : ${YELLOW}${serverTime}${NC}"
  echo -e "Total de Instâncias    : ${YELLOW}${totalActiveInstances}${NC}"
  echo -e "Workers Consultados    : ${YELLOW}${workersQueried}${NC}"
  echo -e "Workers Responderam    : ${YELLOW}${workersResponded}${NC}"
  echo -e "--------------------------------------------------"

  # Agora processa o array de instâncias
  # O restante da saída do jq (o array .instancesGlobal) será lido pelo loop abaixo
  
  first_instance=true
  while IFS= read -r instance_json_line; do
    # Se a linha não for um JSON válido de instância (ex: colchetes de início/fim do array), pule
    if ! echo "$instance_json_line" | jq -e .instanceId > /dev/null 2>&1; then
        continue
    fi

    if [ "$first_instance" = false ]; then
      echo -e "--------------------------------------------------"
    fi
    first_instance=false

    # Extrair cada campo individualmente
    instanceId=$(echo "$instance_json_line" | jq -r '.instanceId // "N/A"')
    workerId=$(echo "$instance_json_line" | jq -r '.workerId // "N/A"')
    instanceName=$(echo "$instance_json_line" | jq -r '.instanceName // "N/A"')
    # MODIFICAÇÃO AQUI: Extrair 'status' e aplicar cores no Bash
    status=$(echo "$instance_json_line" | jq -r '.status // "N/A"')
    
    case "$status" in
        "open")
            statusDisplay="${GREEN}${status^^}${NC}" # Conectado - Verde
            ;;
        "disconnected"|"qr_limit_reached"|"qr_limit_reached_notified"|"error")
            statusDisplay="${RED}${status^^}${NC}" # Desconectado/Erro - Vermelho
            ;;
        "qr_pending")
            statusDisplay="${YELLOW}${status^^}${NC}" # QR Pendente - Amarelo
            ;;
        "connecting"|"initializing")
            statusDisplay="${CYAN}${status^^}${NC}" # Conectando/Inicializando - Ciano
            ;;
        *)
            statusDisplay="${YELLOW}${status^^}${NC}" # Outros status - Amarelo (padrão)
            ;;
    esac

    connectedJid=$(echo "$instance_json_line" | jq -r '.connectedJid // "N/A"')
    qrPending=$(echo "$instance_json_line" | jq -r '.qrPending // "false"')
    qrSendAttempts=$(echo "$instance_json_line" | jq -r '.qrSendAttempts // 0')
    relayToInboxId=$(echo "$instance_json_line" | jq -r '.relayToInboxId // "N/A"')
    relayToAccountId=$(echo "$instance_json_line" | jq -r '.relayToAccountId // "N/A"')
    lastError=$(echo "$instance_json_line" | jq -r '.lastError // ""')


    echo -e "${MAGENTA}Instância ID    : ${NC}${instanceId}"
    echo -e "  Worker ID       : ${workerId}"
    echo -e "  Nome            : ${instanceName}"
    echo -e "  Status          : ${statusDisplay}" # Usa o statusDisplay que já tem cor
    echo -e "  JID Conectado   : ${connectedJid}"
    echo -e "  QR Pendente     : ${qrPending}"
    echo -e "  Tentativas QR   : ${qrSendAttempts}"
    echo -e "  Relay p/ Inbox  : ${relayToInboxId}"
    echo -e "  Relay p/ Conta  : ${relayToAccountId}"
    if [[ -n "$lastError" && "$lastError" != "null" ]]; then
      echo -e "  Último Erro    : ${RED}${lastError}${NC}"
    fi
  done < <(curl -s "$SERVER_URL" | jq -c '.instancesGlobal[]? // empty') # Processa cada instância como uma linha JSON

  if [ "$totalActiveInstances" -eq 0 ]; then
    echo "Nenhuma instância para exibir."
  fi
}

echo -e "${CYAN}==================================================${NC}"