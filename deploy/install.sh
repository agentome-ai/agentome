#!/bin/sh
# Installs Agentome with Docker Compose on a machine that has Docker:
#
#   curl -fsSL https://agentome.ai/install.sh | sh
#
# At a terminal it asks for the folder, the address people open (a domain for HTTPS, or this
# machine only) and whether people's agents run here, in places on the server; flags answer the
# same without a terminal:
#
#   curl -fsSL https://agentome.ai/install.sh | sh -s -- --domain agentome.example.com --places
#
# It downloads compose.yaml, .env.example and deploy/Caddyfile of the release it names, writes
# .env, turns gVisor on for places when Docker has it, pulls the images, starts them and prints
# the address of the first-run setup. Run again in the same folder, it updates to its release and
# keeps .env and the Caddyfile. AGENTOME_INSTALL_BASE replaces where the files come from, for a
# mirror.
set -eu

# The release this script installs; the release commit sets it with compose.yaml's.
RELEASE=0.3.0

usage() {
  cat <<'EOF'
Usage: curl -fsSL https://agentome.ai/install.sh | sh -s -- [options]

  --dir <folder>      where the server's files go (default ./agentome)
  --domain <name>     the domain people open, served over HTTPS with a Let's Encrypt certificate
  --local             no domain: plain HTTP on this machine only
  --port <port>       the port of a local server (default 3000)
  --places            run people's agents here, in places on the server (the default)
  --no-places         no places: agents run on people's computers or the server seat
  --version <x.y.z>   another release than this script's
  --yes               ask nothing; what no flag says takes its default
  --help              this text

Without a terminal, or with --yes, nothing is asked. Run again in the same folder to update.
EOF
}

fail() {
  printf 'agentome install: %s\n' "$1" >&2
  exit 1
}

say() {
  printf '%s\n' "$1"
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
    echo 'Agentome: installing the server on this machine'
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
        7) printf '%s' 'Installing the server on this machine' ;;
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

# Whether a person is at a terminal to answer: curl | sh reads the script from the pipe, so the
# answers come from the terminal itself.
can_ask() {
  [ "$yes" = 0 ] && [ -z "${CI:-}" ] && { : </dev/tty; } 2>/dev/null
}

# Asks a question at the terminal; Enter takes the default.
ask() {
  printf '%s' "$1" >/dev/tty
  [ -n "$2" ] && printf ' [%s]' "$2" >/dev/tty
  printf ': ' >/dev/tty
  read -r answer </dev/tty || answer=''
  [ -n "$answer" ] || answer=$2
}

# Asks a yes-or-no question; Enter takes the default, y or n.
ask_yes() {
  hint='Y/n'
  [ "$2" = y ] || hint='y/N'
  printf '%s [%s]: ' "$1" "$hint" >/dev/tty
  read -r answer </dev/tty || answer=''
  case $answer in
    [Yy]*) answer=y ;;
    [Nn]*) answer=n ;;
    *) answer=$2 ;;
  esac
}

# A setting's value in .env, empty when it is not there.
env_value() {
  sed -n "s/^$1=//p" .env | tail -n 1
}

# Sets a setting in .env: in place of its line, or added at the end.
set_env() {
  if grep -q "^$1=" .env; then
    awk -v name="$1" -v value="$2" 'index($0, name "=") == 1 { print name "=" value; next } { print }' \
      .env >.env.new
  else
    cat .env >.env.new
    printf '%s=%s\n' "$1" "$2" >>.env.new
  fi
  mv .env.new .env
}

# Adds a compose profile to COMPOSE_PROFILES, once.
add_profile() {
  profiles=$(env_value COMPOSE_PROFILES)
  case ",$profiles," in
    *",$1,"*) ;;
    *) set_env COMPOSE_PROFILES "${profiles:+$profiles,}$1" ;;
  esac
}

# The `agentome` command for this server, from anywhere: it remembers the folder, and does there
# what an admin otherwise types with docker compose. Where Claude Code puts `claude`: ~/.local/bin,
# or /usr/local/bin for root.
install_command() {
  if [ "$(id -u)" = 0 ] && [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
    bindir=/usr/local/bin
  else
    bindir=$HOME/.local/bin
  fi
  mkdir -p "$bindir"
  quoted=$(printf '%s' "$(pwd)" | sed "s/'/'\\\\''/g")
  {
    echo '#!/bin/sh'
    echo '# Agentome on this machine, written by https://agentome.ai/install.sh: agentome help.'
    printf "AGENTOME_DIR='%s'\n" "$quoted"
    if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then
      printf "export COMPOSE_PROJECT_NAME='%s'\n" "$COMPOSE_PROJECT_NAME"
    fi
    cat <<'EOF'
set -eu
here=$(pwd)
fail() {
  printf 'agentome: %s\n' "$1" >&2
  exit 1
}
usage() {
  cat <<'USAGE'
Usage: agentome <command>

  status                  what runs, the version and the address
  start | stop | restart  the server and its services
  logs [service]          follow the server's log (app by default)
  update [--version x.y.z]
                          to the latest release, or the one named; .env keeps your settings
  backup [file]           the database, to agentome-<date>.tar.gz or the file named
  restore <file>          the database from a backup; the server stops meanwhile
  setup-code              the code the first admin types at /setup
  reset-password <email>  a one-time link that sets a new password for an account
  rotate-key              a new secret key, for one that may have leaked
  dir                     the server's folder
USAGE
}
cd "$AGENTOME_DIR" 2>/dev/null || fail "the server's folder $AGENTOME_DIR is gone"
# The place launcher is a service only where places are on.
launcher=''
case ",$(sed -n 's/^COMPOSE_PROFILES=//p' .env 2>/dev/null)," in
  *,places,*) launcher=place-launcher ;;
esac
# A path the admin typed is theirs, from where they typed it.
from_here() {
  case $1 in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$here" "$1" ;;
  esac
}
command=${1:-help}
[ $# -eq 0 ] || shift
case $command in
  status)
    docker compose ps
    printf 'Version: %s\n' "$(sed -n 's/^AGENTOME_VERSION=//p' .env)"
    url=$(docker compose exec -T app printenv AGENTOME_PUBLIC_URL </dev/null 2>/dev/null || true)
    [ -z "$url" ] || printf 'Address: %s\n' "$url"
    printf 'Folder: %s\n' "$AGENTOME_DIR"
    ;;
  start) docker compose up -d --wait ;;
  stop) docker compose stop ;;
  restart) docker compose restart ;;
  logs)
    [ $# -gt 0 ] || set -- app
    docker compose logs -f --tail 200 "$@"
    ;;
  update)
    curl -fsSL "${AGENTOME_INSTALL_URL:-https://agentome.ai/install.sh}" | sh -s -- --yes "$@"
    ;;
  backup)
    file=$(from_here "${1:-agentome-$(date +%F).tar.gz}")
    (umask 077 && docker compose exec -T app agentome backup </dev/null >"$file")
    printf 'Backed up to %s. Keep the secret key apart from it: agentome.ai/docs/deploy/\n' "$file"
    ;;
  restore)
    [ $# -eq 1 ] || fail 'usage: agentome restore <file>'
    file=$(from_here "$1")
    [ -f "$file" ] || fail "no such file: $file"
    docker compose stop app
    docker compose run --rm -T app agentome restore <"$file"
    docker compose up -d --wait
    ;;
  setup-code) docker compose exec -T app agentome setup-code </dev/null ;;
  reset-password)
    [ $# -eq 1 ] || fail 'usage: agentome reset-password <email>'
    docker compose exec -T app agentome reset-password "$1" </dev/null
    ;;
  rotate-key)
    # shellcheck disable=SC2086
    docker compose stop app $launcher
    if [ -t 0 ]; then
      docker compose run --rm app agentome rotate-key
    else
      docker compose run --rm -T app agentome rotate-key
    fi
    docker compose up -d --wait
    ;;
  dir) printf '%s\n' "$AGENTOME_DIR" ;;
  help | --help | -h) usage ;;
  *) usage >&2; fail "unknown command $command" ;;
esac
EOF
  } >"$bindir/agentome.new"
  chmod 755 "$bindir/agentome.new"
  mv "$bindir/agentome.new" "$bindir/agentome"
  command_path=$bindir/agentome
}

# Called on the last line: under `curl | sh` nothing runs before the whole script is in, and
# no command reads the rest of the script from the pipe.
main() {
  dir='' domain='' local=0 port='' places='' version=$RELEASE yes=0
  while [ $# -gt 0 ]; do
    case $1 in
      --dir) [ $# -ge 2 ] || fail '--dir needs a folder'; dir=$2; shift ;;
      --domain) [ $# -ge 2 ] || fail '--domain needs a name'; domain=$2; shift ;;
      --local) local=1 ;;
      --port) [ $# -ge 2 ] || fail '--port needs a number'; port=$2; shift ;;
      --places) places=y ;;
      --no-places) places=n ;;
      --version) [ $# -ge 2 ] || fail '--version needs a release, such as 0.3.0'; version=$2; shift ;;
      --yes | -y) yes=1 ;;
      --help | -h) usage; exit 0 ;;
      *) usage >&2; fail "unknown option $1" ;;
    esac
    shift
  done
  case $version in
    *[!0-9.]* | '' ) fail "$version is not a release, such as 0.3.0" ;;
  esac
  base="${AGENTOME_INSTALL_BASE:-https://raw.githubusercontent.com/agentome-ai/agentome/v$version}"

  banner
  command -v curl >/dev/null 2>&1 || fail 'curl is not installed'
  command -v docker >/dev/null 2>&1 || fail 'Docker is not installed: https://docs.docker.com/engine/install/'
  docker compose version >/dev/null 2>&1 || fail 'the Docker Compose plugin is missing: https://docs.docker.com/compose/install/'
  docker info >/dev/null 2>&1 || fail 'cannot reach Docker: start it, or run this as a user of the docker group'

  # A folder that has a .env already is an installation to update: its settings stay, unless a
  # flag changes one. Run in the installation's own folder, or beside it in ./agentome.
  if [ -z "$dir" ]; then
    if [ -f .env ] && [ -f compose.yaml ]; then
      dir=.
    elif [ -f agentome/.env ]; then
      dir=agentome
    fi
  fi
  if [ -z "$dir" ] && can_ask; then
    ask 'Folder for the server' './agentome'
    dir=$answer
  fi
  dir=${dir:-./agentome}
  updating=0
  [ -f "$dir/.env" ] && updating=1

  if [ "$updating" = 0 ] && [ -z "$domain" ] && [ "$local" = 0 ] && can_ask; then
    ask 'Domain people open, for HTTPS, such as agentome.example.com (Enter for this machine only)' ''
    domain=$answer
  fi
  domain=$(printf '%s' "$domain" | sed -e 's#^https\{0,1\}://##' -e 's#/*$##' | tr '[:upper:]' '[:lower:]')
  if [ -n "$domain" ] && ! printf '%s' "$domain" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'; then
    fail "$domain is not a domain name"
  fi
  case $port in
    '' ) ;;
    *[!0-9]* ) fail "$port is not a port" ;;
  esac
  if [ "$updating" = 0 ] && [ -z "$places" ]; then
    if can_ask; then
      ask_yes "Run people's agents here, in places on the server (nothing to install on their computers)" y
      places=$answer
    else
      places=y
    fi
  fi

  # gVisor gives every place and every run a kernel of its own; without it they share this one.
  runtimes=$(docker info --format '{{range $name, $_ := .Runtimes}}{{$name}} {{end}}' 2>/dev/null || true)
  gvisor=0
  case " $runtimes " in *' runsc '*) gvisor=1 ;; esac
  if [ "$places" = y ] && [ "$gvisor" = 0 ]; then
    say 'gVisor (runsc) is not registered with Docker: places would share this machine'"'"'s kernel.'
    say 'Install it: https://gvisor.dev/docs/user_guide/install/ (see agentome.ai/docs/deploy/).'
    if can_ask; then
      ask_yes 'Go on without gVisor' y
      [ "$answer" = y ] || fail 'install gVisor, then run this again'
    fi
  fi

  say "Downloading Agentome $version into $dir"
  mkdir -p "$dir/deploy"
  cd "$dir"

  # compose.yaml names its project agentome, whatever the folder: a second installation on this
  # machine would take over the first one's containers and database.
  project=${COMPOSE_PROJECT_NAME:-agentome}
  running=$(docker ps --filter "label=com.docker.compose.project=$project" \
    --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | sort -u | head -n 1)
  if [ -n "$running" ] && [ "$running" != "$(pwd -P)" ] && [ "$running" != "$(pwd)" ]; then
    fail "Agentome already runs on this machine from $running: run this there to update it, or set COMPOSE_PROJECT_NAME for a second installation"
  fi
  download compose.yaml
  download .env.example
  if [ -f deploy/Caddyfile ]; then
    say 'Keeping deploy/Caddyfile as it is.'
  else
    download deploy/Caddyfile
  fi

  umask 077
  [ -f .env ] || cp .env.example .env
  set_env AGENTOME_VERSION "$version"
  if [ -n "$domain" ]; then
    set_env AGENTOME_PROXY_HOST "$domain"
    set_env AGENTOME_PUBLIC_URL "https://$domain"
    add_profile proxy
  fi
  [ -z "$port" ] || set_env AGENTOME_HTTP_PORT "$port"
  if [ "$places" = y ]; then
    set_env AGENTOME_PLACE_LAUNCHER_URL http://place-launcher:8080
    add_profile places
    if [ "$gvisor" = 1 ]; then
      set_env AGENTOME_PLACE_RUNTIME runsc
      say 'Places run under gVisor.'
      # A Docker of each run's own, for tests that start containers, under its own runtime.
      case " $runtimes " in
        *' runsc-docker '*) set_env AGENTOME_PLACE_DOCKER_RUNTIME runsc-docker; say 'Each run gets a Docker of its own.' ;;
      esac
    fi
  fi

  # A new installation gets a database password of its own. One whose database exists keeps the
  # password the database was made with: changing it here would lock the app out.
  if [ -z "$(env_value AGENTOME_POSTGRES_PASSWORD)" ] &&
    ! docker volume inspect "${project}_agentome-postgres" >/dev/null 2>&1; then
    set_env AGENTOME_POSTGRES_PASSWORD "$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
    say 'Made a password for the database, in .env.'
  fi

  docker compose pull || fail 'cannot pull the images from Docker Hub; check that this machine
  reaches docker.io, or set --version to a release that exists'
  docker compose up -d --wait --wait-timeout 180 ||
    fail 'not healthy after three minutes: see docker compose logs app'
  url=$(docker compose exec -T app printenv AGENTOME_PUBLIC_URL </dev/null)
  code=$(docker compose exec -T app agentome setup-code </dev/null)
  say ''
  say "Agentome is running. Open ${url%/}/setup to create the administrator, with the setup code $code"
  if [ -n "$domain" ]; then
    say "For HTTPS, $domain must point at this machine, with ports 80 and 443 open to Let's Encrypt."
    say 'Inside a company network, use the company'"'"'s certificate: agentome.ai/docs/deploy/'
  fi
  install_command
  say ''
  say "The agentome command runs this server from anywhere: agentome status, agentome update,"
  say 'agentome backup, agentome logs; agentome help lists them all.'
  case ":$PATH:" in
    *":${command_path%/agentome}:"*) ;;
    *) say "Add ${command_path%/agentome} to your PATH to use it, or run $command_path." ;;
  esac
}

main "$@"
