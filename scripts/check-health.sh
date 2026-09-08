#!/bin/bash
#
# check-health.sh — controleert Docker healthcheck-status van de Visiyon-stack,
# logt elke wijziging, en mailt bij een statusverandering via de eigen
# (selfhosted) Exchange-server — geen mailutils/msmtp nodig, alleen curl.

# ---- Instellingen ----
CONTAINERS=("visiyon-backend" "visiyon-frontend" "visiyon-nginx" "visiyon-postgres" "visiyon-redis")
STATE_FILE="/tmp/visiyon-health-state"
LOG_FILE="$HOME/visiyon-health.log"

SMTP_HOST="mail.visiyon.com"
SMTP_PORT="587"
MAIL_FROM="it@visiyon.com"
MAIL_TO="it@visiyon.com"
# Wachtwoord staat NIET hier, maar in een apart bestand met beperkte
# rechten (chmod 600) — zie install-notes.txt voor het aanmaken ervan.
SMTP_PASS_FILE="$HOME/.visiyon-mail-pass"

# ---- Logica ----
touch "$STATE_FILE" "$LOG_FILE"

unhealthy_now=()

for c in "${CONTAINERS[@]}"; do
  if ! docker inspect "$c" >/dev/null 2>&1; then
    status="missing"
  else
    status=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$c")
  fi

  if [[ "$status" == "unhealthy" || "$status" == "missing" ]]; then
    unhealthy_now+=("$c: $status")
  fi
done

prev_state=$(cat "$STATE_FILE" 2>/dev/null)
current_state=$(printf '%s\n' "${unhealthy_now[@]}")

send_mail() {
  local subject="$1"
  local body="$2"

  if [[ ! -f "$SMTP_PASS_FILE" ]]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') WAARSCHUWING: kon geen mail sturen — $SMTP_PASS_FILE ontbreekt" >> "$LOG_FILE"
    return
  fi
  local pass
  pass=$(cat "$SMTP_PASS_FILE")

  curl -s --url "smtp://${SMTP_HOST}:${SMTP_PORT}" \
    --ssl-reqd \
    --login-options 'AUTH=LOGIN' \
    --mail-from "$MAIL_FROM" \
    --mail-rcpt "$MAIL_TO" \
    --user "${MAIL_FROM}:${pass}" \
    --upload-file - << EOF
From: Visiyon Monitor <${MAIL_FROM}>
To: ${MAIL_TO}
Subject: ${subject}

${body}
EOF
}

if [[ "$current_state" != "$prev_state" ]]; then
  if [[ ${#unhealthy_now[@]} -gt 0 ]]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') PROBLEEM:" >> "$LOG_FILE"
    printf '  %s\n' "${unhealthy_now[@]}" >> "$LOG_FILE"

    body="De volgende containers zijn niet gezond:

$(printf '%s\n' "${unhealthy_now[@]}")

Tijd: $(date '+%Y-%m-%d %H:%M:%S')
Server: $(hostname)

Check met: docker inspect <container> --format='{{json .State.Health}}' | python3 -m json.tool
Logs met:  docker logs <container> --tail 50"
    send_mail "[Visiyon] Waarschuwing: ${#unhealthy_now[@]} service(s) unhealthy" "$body"
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') OK: alle containers weer gezond" >> "$LOG_FILE"
    send_mail "[Visiyon] Hersteld: alle services gezond" "Alle containers zijn weer gezond op $(date '+%Y-%m-%d %H:%M:%S')."
  fi
fi

echo "$current_state" > "$STATE_FILE"
