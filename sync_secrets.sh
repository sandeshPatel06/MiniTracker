#!/usr/bin/env bash
set -e

ENV_FILE=".env"
FLY_BIN="$HOME/.fly/bin/fly"

if [ ! -f "$ENV_FILE" ]; then
    echo "Error: $ENV_FILE not found!"
    exit 1
fi

echo "Reading non-empty variables from $ENV_FILE and preparing Fly.io secrets sync..."

SECRETS_ARGS=()
while IFS= read -r line || [ -n "$line" ]; do
    # Trim leading/trailing whitespace
    line="$(echo "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    
    # Skip comments and empty lines
    if [[ -z "$line" || "$line" == \#* ]]; then
        continue
    fi
    
    # Extract KEY and VALUE
    KEY="${line%%=*}"
    VALUE="${line#*=}"
    
    # Strip quotes if wrapped
    VALUE="$(echo "$VALUE" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
    
    # Ignore unset or empty values, and non-secret local runtime vars
    if [ -n "$VALUE" ]; then
        if [[ "$KEY" == "PORT" || "$KEY" == "DATA_DIR" || "$KEY" == "PRIVACY_MODE_ENABLED" || "$KEY" == "PRIVACY_BLUR_STYLE" || "$KEY" == "PRIVACY_BLUR_RADIUS" || "$KEY" == "IDLE_DETECTION_ENABLED" || "$KEY" == "IDLE_THRESHOLD_SECONDS" || "$KEY" == "DISTRACTION_ALERTS_ENABLED" || "$KEY" == "DISTRACTION_THRESHOLD_SECONDS" || "$KEY" == "SCREENSHOT_INTERVAL_SECONDS" || "$KEY" == "AI_ANALYSIS_INTERVAL_SECONDS" ]]; then
            continue
        fi
        SECRETS_ARGS+=("${KEY}=${VALUE}")
    fi
done < "$ENV_FILE"

if [ ${#SECRETS_ARGS[@]} -eq 0 ]; then
    echo "No non-empty secrets found in $ENV_FILE."
    exit 0
fi

echo "Syncing ${#SECRETS_ARGS[@]} secrets securely to Fly.io..."
"$FLY_BIN" secrets set "${SECRETS_ARGS[@]}"

echo "Secrets successfully updated on Fly.io!"
