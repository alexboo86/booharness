#!/usr/bin/env bash
set -u; R="$(dirname "$0")/../evidence-rank.sh"; fail=0
chk(){ local got; got=$(bash "$R" "$1"); [ "$got" = "$2" ] || { echo "FAIL: $1 -> $got (want $2)"; fail=1; }; }
chk canonical 5
chk test-confirmed 4
chk operator-confirmed 3
chk repeated 2
chk observed-once 1
chk "" 0
chk garbage 0
# legacy confidence maps below operator-confirmed (incentive to reclassify)
chk legacy:high 2
chk legacy:medium 1
chk legacy:low 1
[ $fail -eq 0 ] && echo PASS || exit 1
