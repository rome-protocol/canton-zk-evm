#!/usr/bin/env bash
# Stands in for the fast ZisK emulator: ziskemu -e <elf> -i <input> --max-input-mem <bytes> --steps
# What it does is set by the first line of the input file, as words: steps=<n> (the step count it reports), sleep=<seconds> (slow),
# abort=heap (the guest runs out of heap) or abort=fail (the guest's block validation fails), child=<file> (leaves a helper that
# sleeps in the background and writes its process id to the file, to see the process group killed).
set -euo pipefail
elf="" input=""
while [ $# -gt 0 ]; do
  case "$1" in
    -e) elf=$2; shift 2 ;;
    -i) input=$2; shift 2 ;;
    --max-input-mem) shift 2 ;;
    --steps) shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -s "$elf" ] || { echo "missing elf $elf" >&2; exit 1; }
[ -s "$input" ] || { echo "missing input $input" >&2; exit 1; }
echo "ziskemu -e $elf -i $input" >> "${FAKE_LOG:?}"
line=$(head -n 1 "$input")
word() { for w in $line; do case "$w" in "$1="*) echo "${w#*=}"; return ;; esac; done; }
if [ -n "$(word child)" ]; then sleep 30 & echo $! > "$(word child)"; fi
if [ -n "$(word sleep)" ]; then sleep "$(word sleep)"; fi
case "$(word abort)" in
  heap) echo "thread 'main' panicked: OOM limit of heap with bump allocator" >&2; exit 101 ;;
  fail) echo "Block validation failed: gas used mismatch" >&2; exit 1 ;;
esac
echo "Block validation succeeded"
n=$(word steps)
printf 'STEPS: %s\n' "$(python3 -c 'import sys; print(f"{int(sys.argv[1]):,}")' "${n:-1000}")"
