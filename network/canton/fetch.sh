#!/usr/bin/env bash
# Installs the Canton and Daml tools in PINS into a folder (default state/tools): the dpm program, the Daml SDK
# snapshot (compiler included) and the Canton jar. Every download is checked against a SHA-256 in PINS; the compiler,
# which the SDK manifest names by version only, is checked through the SHA-256 of its manifest in the registry.
# Safe to run again; what is already there and matches is kept.
#
# Prints, on its last lines, the two paths the other scripts use:
#   DPM=<path of dpm>   CANTON_JAR=<path of the jar>
# Needs curl, jq and Java (JAVA_MAJOR in PINS or newer); installs Java through apt if it is missing.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
TOOLS=${CZE_TOOLS_DIR:-${CZE_STATE_DIR:-$ROOT/state}/tools}
fail() { echo "FAIL: $*" >&2; exit 1; }
sha() { sha256sum "$1" | cut -d' ' -f1; }

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=linux_amd64 ;;
  *) fail "this fetches the Linux x86-64 tools only" ;;
esac

# Java for Canton.
java_major() { java -version 2>&1 | sed -n '1s/.*version "\([0-9]*\).*/\1/p'; }
if ! command -v java >/dev/null || [ "$(java_major)" -lt "$JAVA_MAJOR" ]; then
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "openjdk-${JAVA_MAJOR}-jre-headless"
fi
[ "$(java_major)" -ge "$JAVA_MAJOR" ] || fail "Java $JAVA_MAJOR or newer is needed"

mkdir -p "$TOOLS/bin"
DPM=$TOOLS/bin/dpm

# dpm itself: one file in the registry, found through its manifest.
if [ ! -x "$DPM" ] || [ "$(sha "$DPM")" != "$DPM_LINUX_AMD64_SHA256" ]; then
  base=https://${DPM_REGISTRY%%/*}/v2/${DPM_REGISTRY#*/}/components/dpm
  digest=$(curl -sSf -H 'Accept: application/vnd.oci.image.manifest.v1+json' "$base/manifests/$DPM_VERSION.$platform" \
    | jq -r '.layers[] | select(.annotations["com.digitalasset.file-name"] == "dpm" or .annotations["org.opencontainers.image.title"] == "dpm") | .digest')
  [[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || fail "the registry has no dpm file for $DPM_VERSION"
  curl -sSfL -o "$DPM.part" "$base/blobs/$digest"
  [ "$(sha "$DPM.part")" = "$DPM_LINUX_AMD64_SHA256" ] || { rm -f "$DPM.part"; fail "dpm does not match DPM_LINUX_AMD64_SHA256"; }
  chmod 755 "$DPM.part"; mv "$DPM.part" "$DPM"
fi

# The SDK snapshot: the compiler and the Canton jar, among others. dpm checks each blob against the registry's digest.
export DPM_HOME=$TOOLS/dpm DPM_REGISTRY
manifest=$DPM_HOME/cache/sdk/open-source/$DAML_SDK_VERSION.yaml
if [ ! -f "$manifest" ]; then
  # A snapshot's version tag can be pushed again, so the compiler is checked by content before and after it is installed.
  "$ROOT/network/canton/check-damlc.sh" >&2
  "$DPM" install "$DAML_SDK_TAG"
fi
[ -f "$manifest" ] || fail "dpm did not install the SDK $DAML_SDK_VERSION from $DAML_SDK_TAG"
[ "$(sha "$manifest")" = "$DAML_SDK_MANIFEST_SHA256" ] || fail "the SDK manifest does not match DAML_SDK_MANIFEST_SHA256"
grep -q "version: $CANTON_VERSION\$" "$manifest" || fail "the SDK does not carry Canton $CANTON_VERSION"
grep -q "version: $DAMLC_VERSION\$" "$manifest" || fail "the SDK does not carry damlc $DAMLC_VERSION"
"$ROOT/network/canton/check-damlc.sh" >&2

JAR=$DPM_HOME/cache/components/canton-open-source/$CANTON_VERSION/lib/canton-open-source-$CANTON_VERSION.jar
[ -f "$JAR" ] || fail "no Canton jar at $JAR"
[ "$(sha "$JAR")" = "$CANTON_JAR_SHA256" ] || fail "the Canton jar does not match CANTON_JAR_SHA256"

echo "DPM=$DPM"
echo "DPM_HOME=$DPM_HOME"
echo "CANTON_JAR=$JAR"
