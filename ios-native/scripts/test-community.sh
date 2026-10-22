#!/bin/sh
# Runs the Community (Phase 4), Sightings / Account / Moderation (Phase 5) and
# Phase 5.1 UI tests against the isolated test Worker
# (scripts/community-test-server.mjs: the real Worker over an in-memory
# database; nothing touches production). Extra arguments go to xcodebuild.
#
#   ios-native/scripts/test-community.sh
#   ONLY="CybercabHunterUITests/CommunityUITests/testSignedOutIsReadOnly" ios-native/scripts/test-community.sh
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
PORT=8799
node "$HERE/community-test-server.mjs" --serve "$PORT" >/tmp/cch-community-server.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  /usr/bin/curl -sf "http://127.0.0.1:$PORT/api/social/sidebar" >/dev/null && break
  sleep 1
done
cd "$HERE/.."
ONLY_ARGS=""
for t in ${ONLY:-CybercabHunterUITests/CommunityUITests CybercabHunterUITests/SightingsAccountUITests CybercabHunterUITests/Phase51UITests}; do ONLY_ARGS="$ONLY_ARGS -only-testing:$t"; done
# shellcheck disable=SC2086
xcodebuild -project CybercabHunter.xcodeproj -scheme CybercabHunter \
  -destination "${DESTINATION:-platform=iOS Simulator,name=iPhone 18 Pro}" \
  $ONLY_ARGS "$@" test
