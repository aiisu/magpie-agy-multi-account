#!/bin/sh
umask 077
case "$1" in
  --version|--help) exec "$AGY_REAL_PATH" "$@" ;;
esac
if [ "$1" = acp ] && [ "$2" = --help ]; then
  exec "$AGY_REAL_PATH" "$@"
fi
attempt=0
while [ "$attempt" -lt 80 ]; do
  for slot in 0 1; do
    exec 8>"$AGY_ACCOUNT_SLOTS/slot-$slot.lock"
    if /usr/bin/flock -n 8; then
      exec "$AGY_REAL_PATH" "$@"
    fi
    exec 8>&-
  done
  attempt=$((attempt + 1))
  sleep 0.1
done
echo 'CLI process capacity busy; retry later.' >&2
exit 75
