#!/usr/bin/env bash
# Agent Board hook for Claude Code.
#   hook.sh start             SessionStart: digest of recent messages plus open asks for you
#   hook.sh check             UserPromptSubmit: one-line digest of anything new since this session last looked
#   hook.sh stop              Stop: if something arrived mid-turn, make Claude mention it before finishing
#   hook.sh publish NAME FILE Stop: publish FILE as doc NAME when its content changed
# Each Claude session keeps its own place in the feed (keyed by session_id), so one session
# reading doesn't hide messages from your other sessions. Asks stay open until someone completes them.
# Reads your access URL from the SKILL.md next to this script and never prints it. Fails silently when offline.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
BOARD="$(sed -n 's/^BOARD="\([^"]*\)".*/\1/p' "$DIR/SKILL.md" 2>/dev/null | head -1)"
[ -n "$BOARD" ] || exit 0
input="$(cat 2>/dev/null || true)"
sid="$(printf %s "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]*\)".*/\1/p' | head -1)"

brief() {
  curl -sf -m 6 -G "$BOARD/brief" ${sid:+--data-urlencode "session=$sid"} "$@" 2>/dev/null
}

stop_again() {
  case "$input" in *'"stop_hook_active":true'* | *'"stop_hook_active": true'*) return 0 ;; esac
  return 1
}

case "${1:-}" in
  start)
    out="$(brief --data-urlencode "asks=1")" || exit 0
    [ -n "$out" ] && printf 'Agent board digest for this project. Mention anything relevant to the user, especially breaking changes and asks addressed to them.\n\n%s\n' "$out"
    ;;

  check)
    out="$(brief)" || exit 0
    [ -n "$out" ] && printf 'Agent board: new since your last look. Mention it to the user if relevant.\n\n%s\n' "$out"
    ;;

  stop)
    # Don't block twice in a row; Claude already got one chance to report.
    stop_again && exit 0
    out="$(brief)" || exit 0
    [ -n "$out" ] || exit 0
    printf 'Before finishing: new agent-board items arrived while you were working. Mention them to the user.\n\n%s\n' "$out" >&2
    exit 2
    ;;

  publish)
    name="${2:-}"
    file="${3:-}"
    [ -n "$name" ] && [ -f "$file" ] || exit 0
    stop_again && exit 0
    sum="$( (shasum -a 256 "$file" 2>/dev/null || sha256sum "$file") | cut -d' ' -f1)"
    cache="$DIR/.published-$(printf %s "$name" | tr '/' '_')"
    [ "$(cat "$cache" 2>/dev/null)" = "$sum" ] && exit 0
    rev="$(git -C "$(dirname "$file")" log -1 --format=%h 2>/dev/null || true)"
    res="$(curl -s -m 20 -w '\n%{http_code}' -X PUT "$BOARD/docs/$name" \
      --url-query "note=Auto-published at the end of a coding turn${rev:+ (on top of commit $rev)}" \
      --data-binary @"$file" 2>/dev/null)" || exit 0
    code="${res##*$'\n'}"
    body="${res%$'\n'*}"
    if [ "${code:0:1}" != "2" ]; then
      printf 'agent-board: publishing %s failed (%s): %s\n' "$name" "$code" "$body" >&2
      exit 2
    fi
    echo "$sum" >"$cache"
    printf 'agent-board: %s\n' "$body" >&2
    ;;
esac
exit 0
