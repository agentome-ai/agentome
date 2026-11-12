#!/bin/sh
# Rejects a commit message whose subject is not a Conventional Commit. Git runs it as the
# commit-msg hook (wired up by simple-git-hooks in package.json) and CI runs it on the PR title
# (.github/workflows/pr-title.yml), so both apply exactly the same rules.
# Messages that Git writes itself ("Merge ...", "Revert ...") are rejected too:
# history is linear, and a revert gets a message of its own (git revert -e).
#
# Usage: sh scripts/commit-msg.sh <file with the message>

types='feat|fix|refactor|test|docs|chore|ci|perf'
scopes='server|web|worker|db|shared|costs|deploy|docs|ci'
max_length=72

# The subject is the first line that is neither blank nor a '#' comment.
subject=$(grep -v '^#' "$1" | sed -n '/[^[:space:]]/{p;q;}')

fail() {
  {
    printf 'Invalid commit message: %s\n' "$1"
    printf '  subject:  %s\n' "$subject"
    printf '  expected: type(scope): summary   (the scope is optional)\n'
    printf '  types:    %s\n' "$types"
    printf '  scopes:   %s\n' "$scopes"
    printf '  summary:  imperative, no trailing period, subject at most %s characters\n' "$max_length"
  } >&2
  exit 1
}

printf '%s\n' "$subject" | grep -Eq "^($types)(\(($scopes)\))?: [^[:space:]]" ||
  fail 'the subject must look like "type(scope): summary"'

case $subject in
  *.) fail 'the subject must not end with a period' ;;
esac

length=$(printf '%s' "$subject" | wc -m | tr -d '[:space:]')
[ "$length" -le "$max_length" ] || fail "the subject is $length characters long"
