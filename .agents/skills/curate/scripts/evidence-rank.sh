#!/usr/bin/env bash
# Map an evidence_class (or legacy confidence) to a trust rank 0..5 for recall ranking.
# Scale: observed-once<repeated<operator-confirmed<test-confirmed<canonical.
# Legacy `confidence: high/medium/low` maps BELOW operator-confirmed to incentivise reclassification.
set -u
case "${1:-}" in
  canonical)          echo 5 ;;
  test-confirmed)     echo 4 ;;
  operator-confirmed) echo 3 ;;
  repeated)           echo 2 ;;
  observed-once)      echo 1 ;;
  legacy:high)        echo 2 ;;
  legacy:medium)      echo 1 ;;
  legacy:low)         echo 1 ;;
  *)                  echo 0 ;;
esac
