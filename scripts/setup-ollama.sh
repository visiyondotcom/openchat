#!/bin/bash
# Run once on the VM (not inside Docker) to configure Ollama for:
#  - concurrent requests from multiple users (OLLAMA_NUM_PARALLEL)
#  - multiple models kept warm at once (OLLAMA_MAX_LOADED_MODELS)
#  - listening on all interfaces so Docker containers can reach it
#  - spreading load across both GPUs
#  - smaller KV cache footprint so more concurrent chats fit in VRAM
#
# Usage: sudo bash setup-ollama.sh

set -e

OVERRIDE_DIR="/etc/systemd/system/ollama.service.d"
OVERRIDE_FILE="$OVERRIDE_DIR/override.conf"

mkdir -p "$OVERRIDE_DIR"

cat > "$OVERRIDE_FILE" << 'EOF'
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_NUM_PARALLEL=4"
Environment="OLLAMA_MAX_LOADED_MODELS=3"
Environment="OLLAMA_MAX_QUEUE=512"
Environment="OLLAMA_KEEP_ALIVE=30m"
Environment="OLLAMA_SCHED_SPREAD=1"
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
EOF

systemctl daemon-reload
systemctl restart ollama

echo "Done. Current Ollama environment:"
systemctl show ollama --property=Environment
