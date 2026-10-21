#!/usr/bin/env bash
# Prints the line that makes a participant call Ostia's sidecar: one environment variable for the participant's container, in the form its
# ADDITIONAL_CONFIG* variables take (HOCON). Run it with the address and port the participant reaches the sidecar on:
#   participant-config.sh <sidecar address> <port> [participant name, default "participant"]
# validate-on-startup is false: a participant that is shared with a validator must still start when the sidecar is down (Ostia's own
# canton.conf sets it true, because there the sidecar is part of the network). While the sidecar is down, a block's check fails and no block commits.
set -euo pipefail
address=${1:-}; port=${2:-}; name=${3:-participant}
[[ $address =~ ^[0-9A-Za-z.-]+$ && $port =~ ^[0-9]{2,5}$ && $name =~ ^[A-Za-z0-9_-]+$ ]] || { echo "usage: participant-config.sh <sidecar address> <port> [participant name]" >&2; exit 2; }
echo "ADDITIONAL_CONFIG_ZK_EVM=canton.participants.$name.parameters.engine.extensions.canton-zk-evm { address = \"$address\", port = $port, validate-on-startup = false }"
