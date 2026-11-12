#!/bin/sh
# Installs Agentome with Docker Compose on a machine that has Docker:
#
#   curl -fsSL https://raw.githubusercontent.com/agentome-ai/agentome/main/deploy/install.sh | sh
#
# Downloads compose.yaml and .env.example into ./agentome, and deploy/Caddyfile when it is not
# there yet, pulls the release, starts it and prints the address of the first-run setup. Run
# again, it updates compose.yaml and the images; .env and the Caddyfile stay as they are.
# The files come from the public repository's main branch; AGENTOME_INSTALL_BASE replaces its
# address, for a mirror.
set -eu

fail() {
  printf 'agentome install: %s\n' "$1" >&2
  exit 1
}

download() {
  curl -fsSL "$base/$1" -o "$1.download" || fail "cannot download $base/$1"
  mv "$1.download" "$1"
}

# The mark on its plate, one character a pixel: a to x are the 24 greys of the terminal's 256-colour
# ramp, dark to light, and a dot is no pixel. Two rows of pixels make one line, drawn with ▀.
MARK='
...bbbbbbbbbbbbbbbbbb...
.bbbbbbbbbbbbbbbbbbbbbb.
.bbbbbbbbbbbbbbbbbbbbbb.
bbbbbbbbbbbbbbbbbbbbbbbb
bbbbbbbbbbbbbbbbbbbbbbbb
bbbbbbbbbbempmdbbbbbbbbb
bbbbbbbbbixxxxxgbbbbbbbb
bbbbbbbbfxxxxxxvcbbbbbbb
bbbbbbbcvxxxxxxxobbbbbbb
bbbbbbbrxsquxxxxxfbbbbbb
bbbbbbmwnljhnxxxwrbbbbbb
bbbbbhwrpnljgqwwwvibbbbb
bbbbdvvtrpnjbduvvuscbbbb
bbbbtxxvtrncbbjuuutlbbbb
bbbnxxxxvsebbbbqttssebbb
bbbxxxxxxgbbbbbesssrmbbb
bbbxxxxxlbbbbbbbkrrrnbbb
bbbnxxxpbbbbbbbbcoqqhbbb
bbbbjqlbbbbbbbbbbcjhbbbb
bbbbbbbbbbbbbbbbbbbbbbbb
bbbbbbbbbbbbbbbbbbbbbbbb
.bbbbbbbbbbbbbbbbbbbbbb.
.bbbbbbbbbbbbbbbbbbbbbb.
...bbbbbbbbbbbbbbbbbb...
'

# Opens the install with the mark, the name typed beside it and what is about to happen. Only for
# a person at a terminal with colours: a log, CI or NO_COLOR gets one plain line.
banner() {
  if [ ! -t 1 ] || [ -n "${NO_COLOR:-}" ] || [ -n "${CI:-}" ] || [ "${TERM:-dumb}" = dumb ]; then
    echo 'Agentome: installing into ./agentome'
    return
  fi
  printf '\n'
  printf '%s\n' "$MARK" | awk '
    NF { rows[n++] = $0 }
    END {
      greys = "abcdefghijklmnopqrstuvwx"
      for (y = 0; y < n; y += 2) {
        top = rows[y]; low = (y + 1 < n) ? rows[y + 1] : ""
        line = "  "
        for (x = 1; x <= length(top); x++) {
          t = index(greys, substr(top, x, 1)); b = index(greys, substr(low, x, 1))
          if (!t && !b) line = line "\033[0m "
          else if (!b) line = line sprintf("\033[0m\033[38;5;%dm\342\226\200", 231 + t)
          else if (!t) line = line sprintf("\033[0m\033[38;5;%dm\342\226\204", 231 + b)
          else line = line sprintf("\033[38;5;%d;48;5;%dm\342\226\200", 231 + t, 231 + b)
        }
        print line "\033[0m"
      }
    }' | {
    row=0
    while IFS= read -r line; do
      printf '%s   ' "$line"
      case $row in
        4) type_out 'agentome' ;;
        5) printf '\033[2m%s\033[0m' 'AI employees, on your own servers' ;;
        7) printf '%s' 'Installing into ./agentome' ;;
      esac
      printf '\n'
      row=$((row + 1))
      pause 0.03
    done
  }
  printf '\n'
}

# Prints a word a letter at a time, in bold.
type_out() {
  word=$1
  printf '\033[1m'
  while [ -n "$word" ]; do
    rest=${word#?}
    printf '%s' "${word%"$rest"}"
    word=$rest
    pause 0.04
  done
  printf '\033[0m'
}

# A short wait where sleep takes fractions of a second, and none where it does not.
pause() {
  sleep "$1" 2>/dev/null || true
}

# Called on the last line: under `curl | sh` nothing runs before the whole script is in, and
# no command reads the rest of the script from the pipe.
main() {
  base="${AGENTOME_INSTALL_BASE:-https://raw.githubusercontent.com/agentome-ai/agentome/main}"
  banner
  command -v curl >/dev/null 2>&1 || fail 'curl is not installed'
  command -v docker >/dev/null 2>&1 || fail 'Docker is not installed: https://docs.docker.com/engine/install/'
  docker compose version >/dev/null 2>&1 || fail 'the Docker Compose plugin is missing: https://docs.docker.com/compose/install/'
  docker info >/dev/null 2>&1 || fail 'cannot reach Docker: start it, or run this as a user of the docker group'

  mkdir -p agentome/deploy
  cd agentome
  download compose.yaml
  download .env.example
  if [ -f deploy/Caddyfile ]; then
    echo 'Keeping deploy/Caddyfile as it is.'
  else
    download deploy/Caddyfile
  fi

  docker compose pull || fail 'cannot pull the images from Docker Hub; check that this machine
  reaches docker.io, or set AGENTOME_VERSION to a release that exists'
  docker compose up -d --wait --wait-timeout 120 ||
    fail 'not healthy after two minutes: see docker compose logs app'
  url=$(docker compose exec -T app printenv AGENTOME_PUBLIC_URL </dev/null)
  code=$(docker compose exec -T app agentome setup-code </dev/null)
  printf 'Agentome is running. Open %s/setup to create the administrator, with the setup code %s\n' \
    "${url%/}" "$code"
}

main "$@"
