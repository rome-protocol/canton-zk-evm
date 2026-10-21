#!/usr/bin/env bash
# Sourced by network/restart.sh and network/down.sh. up.sh writes the settings that name the database containers (Canton's and the explorer's), reth's container and
# their ports into $STATE/persist.env; load_persist_settings reads them back, so that a restart or a wipe acts on the same containers and
# ports as the run that made the chain, whatever the environment of the shell is. A variable that is set to something else is refused:
# acting on another container could start an empty database or wipe the wrong one.
PERSIST_SETTINGS="CZE_PG_CONTAINER CZE_PG_PORT CZE_EXPLORER_DB_CONTAINER CZE_EXPLORER_DB_PORT RETH_CONTAINER RETH_HTTP_PORT RETH_WS_PORT RETH_ENGINE_PORT"
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

# CZE_USER_PREFIX (external mode only: the Ledger API users' names, "ostia-" by default, possibly empty) is recorded by up.sh, and restart.sh uses it.
# A restart in a shell without it must not fall back to the default, and a different explicit value is refused: the participant would not know the users.
# A persist.env from before the prefix was recorded has no line for it, and keeps the default.
load_user_prefix() {   # $1 = the state folder; returns 1 with a message if the environment disagrees
  if grep -q '^CZE_USER_PREFIX=' "$1/persist.env"; then
    local v; v=$(sed -n 's/^CZE_USER_PREFIX=//p' "$1/persist.env")
    if [ -n "${CZE_USER_PREFIX+set}" ] && [ "$CZE_USER_PREFIX" != "$v" ]; then
      echo "FAIL: CZE_USER_PREFIX is '$CZE_USER_PREFIX' here, but the chain in $1 was made with '$v': unset it (or set it to '$v')" >&2
      return 1
    fi
    export CZE_USER_PREFIX=$v
  else
    export CZE_USER_PREFIX=${CZE_USER_PREFIX-ostia-}
  fi
}
