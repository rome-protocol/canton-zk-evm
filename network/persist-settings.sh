#!/usr/bin/env bash
# Sourced by network/restart.sh and network/down.sh. up.sh writes the settings that name the database container, reth's container and
# their ports into $STATE/persist.env; load_persist_settings reads them back, so that a restart or a wipe acts on the same containers and
# ports as the run that made the chain, whatever the environment of the shell is. A variable that is set to something else is refused:
# acting on another container could start an empty database or wipe the wrong one.
PERSIST_SETTINGS="CZE_PG_CONTAINER CZE_PG_PORT RETH_CONTAINER RETH_HTTP_PORT RETH_WS_PORT RETH_ENGINE_PORT"
load_persist_settings() {   # $1 = the state folder; returns 1 with a message if the environment disagrees
  local k v cur
  for k in $PERSIST_SETTINGS; do
    v=$(sed -n "s/^$k=//p" "$1/persist.env")
    [ -n "$v" ] || continue
    cur=${!k:-}
    if [ -n "$cur" ] && [ "$cur" != "$v" ]; then
      echo "FAIL: $k is $cur here, but the chain in $1 was made with $v: unset it (or set it to $v)" >&2
      return 1
    fi
    export "$k=$v"
  done
}
