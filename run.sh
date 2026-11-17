#!/bin/bash
# Wrapper invoked by launchd every 5 minutes.
cd "$(dirname "$0")" || exit 0
mkdir -p logs
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
/opt/homebrew/bin/node monitor.mjs >> logs/run.log 2>&1
