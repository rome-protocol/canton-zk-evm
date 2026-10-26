#!/usr/bin/env bash
# Stands in for the ZisK emulator: ziskemu -e <elf> -i <input> --max-input-mem <bytes> -n <step cap> -X
# It prints the real 1.3.1 -X report layout (a STEPS line with no colon, the cost under COST DISTRIBUTION as a TOTAL line), and at the step cap
# the report and then `Error during emulation: EmulationNoCompleted` with exit 1.
# What it does is set by the first line of the input file, as words: steps=<n> (the step count it reports), sleep=<seconds> (slow),
# abort=heap (the guest runs out of heap) or abort=fail (the guest's block validation fails), child=<file> (leaves a helper that
# sleeps in the background and writes its process id to the file, to see the process group killed), cost=<n> (the TOTAL cost it prints with -X;
# default 3 per step), and the emulator's own faults: abort=kill (killed by a signal), abort=nosteps (exits 0 and prints no figures), abort=crash (exits 3), abort=rc1 (exits 1 with an error that is not the step cap's).
set -euo pipefail
elf="" input="" extended="" cap=""
while [ $# -gt 0 ]; do
  case "$1" in
    -e) elf=$2; shift 2 ;;
    -i) input=$2; shift 2 ;;
    --max-input-mem) shift 2 ;;
    -n) cap=$2; shift 2 ;;
    -X) extended=1; shift ;;
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
  kill) kill -9 $$ ;;
  nosteps) echo "Block validation succeeded"; exit 0 ;;
  crash) echo "segmentation fault" >&2; exit 3 ;;
  rc1) echo "Error during emulation: SomethingElse" >&2; exit 1 ;;
esac
n=$(word steps); n=${n:-1000}
c=$(word cost); c=${c:-$(( n * 3 ))}
fmt() { python3 -c 'import sys; print(f"{int(sys.argv[1]):,}")' "$1"; }
report() {   # the -X report, in the layout of the real one
  printf '\nREPORT                                  \n----------------------------------------\n'
  printf 'STEPS %28s\n\n' "$(fmt "$1")"
  printf 'COST DISTRIBUTION                   COST       %%\n------------------------------------------------\n'
  printf 'MAIN %28s  39.66%%\n' "$(fmt $(( $2 / 3 )))"
  printf 'BASE %28s  24.82%%\n                        ------------------------\n' "$(fmt $(( $2 / 2 )))"
  printf 'TOTAL %27s 100.00%%\n\nFROPS %27s   7.81%%\n' "$(fmt "$2")" "$(fmt $(( $2 / 20 )))"
}
if [ -n "$cap" ] && [ "$n" -ge "$cap" ]; then   # stopped at the cap: the report with the cap as its step count, then the error
  [ -z "$extended" ] || report "$cap" "$c"
  echo "Error during emulation: EmulationNoCompleted"
  exit 1
fi
echo "Block validation succeeded!"
[ -z "$extended" ] || report "$n" "$c"
