#!/usr/bin/env bash
# Start or reattach to a remote `ensemble issue` session in tmux.
#
# Usage:
#   ENSEMBLE_REMOTE_SSH='ssh -J bastion user@host' \
#     scripts/remote-ensemble-issue.sh /path/to/repo 42 -- --profile team
#
# ENSEMBLE_REMOTE_SSH is split on whitespace; shell syntax is never evaluated.
# Put SSH options containing spaces in ~/.ssh/config. The destination must be
# the final word. The script selects SSH's -t/-T option from the local TTY.

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: ENSEMBLE_REMOTE_SSH='ssh [options] user@host' \
  scripts/remote-ensemble-issue.sh <remote-dir> <issue-ref> [-- <issue-args...>]

Arguments:
  remote-dir   Directory on the SSH host (absolute or relative to its login dir)
  issue-ref    Issue number, #number, or GitHub Issue URL
  issue-args   Optional arguments passed to `ensemble issue` after --

Environment:
  ENSEMBLE_REMOTE_SSH       Required; whitespace-separated SSH command and args.
                            The destination must be the final word.
  ENSEMBLE_REMOTE_ENSEMBLE  Remote executable path (default: ensemble)
EOF
}

fail_usage() {
  printf 'remote-ensemble-issue.sh: %s\n' "$1" >&2
  usage
  exit 2
}

if [[ ${1:-} == -h || ${1:-} == --help ]]; then
  usage
  exit 0
fi

if (( $# < 2 )); then
  fail_usage 'remote directory and issue reference are required'
fi

remote_dir=$1
issue_ref=$2
shift 2

if [[ -z $remote_dir ]]; then
  fail_usage 'remote directory must not be empty'
fi

extra_args=()
extra_args_count=0
if (( $# > 0 )); then
  if [[ $1 != -- ]]; then
    fail_usage 'additional ensemble arguments must follow --'
  fi
  shift
  extra_args=("$@")
  extra_args_count=$#
fi

if [[ -z ${ENSEMBLE_REMOTE_SSH:-} ]]; then
  fail_usage 'ENSEMBLE_REMOTE_SSH is required'
fi

if [[ $ENSEMBLE_REMOTE_SSH == *$'\n'* ]]; then
  fail_usage 'ENSEMBLE_REMOTE_SSH must be a single line'
fi

ssh_args=()
IFS=$' \t\n' read -r -a ssh_args <<< "$ENSEMBLE_REMOTE_SSH"
if (( ${#ssh_args[@]} < 2 )); then
  fail_usage 'ENSEMBLE_REMOTE_SSH must include an SSH command and destination'
fi

ssh_destination=${ssh_args[$((${#ssh_args[@]} - 1))]}
if [[ -z $ssh_destination || $ssh_destination == -* ]]; then
  fail_usage 'the SSH destination must be the final word in ENSEMBLE_REMOTE_SSH'
fi

for ssh_arg in "${ssh_args[@]}"; do
  case $ssh_arg in
    -t|-tt|-ttt|-T)
      fail_usage 'do not set SSH -t/-T; TTY allocation is selected automatically'
      ;;
  esac
done

if [[ $issue_ref =~ ^#?([0-9]+)$ ]]; then
  issue_number=${BASH_REMATCH[1]}
elif [[ $issue_ref =~ ^https?://github\.com/[^/]+/[^/]+/issues/([0-9]+)/?$ ]]; then
  issue_number=${BASH_REMATCH[1]}
else
  fail_usage 'issue reference must be a number, #number, or GitHub Issue URL'
fi

while [[ ${#issue_number} -gt 1 && $issue_number == 0* ]]; do
  issue_number=${issue_number#0}
done
if [[ $issue_number == 0 ]]; then
  fail_usage 'issue number must be greater than zero'
fi

trimmed_remote_dir=$remote_dir
while [[ $trimmed_remote_dir == */ && $trimmed_remote_dir != / ]]; do
  trimmed_remote_dir=${trimmed_remote_dir%/}
done
directory_name=${trimmed_remote_dir##*/}
if [[ -z $directory_name ]]; then
  directory_name=root
fi
directory_id=$(printf '%s' "$directory_name" | LC_ALL=C tr -cs 'A-Za-z0-9_-' '-')
directory_id=${directory_id#-}
directory_id=${directory_id%-}
if [[ -z $directory_id ]]; then
  directory_id=repo
fi
session_name="${directory_id}-${issue_number}"
session_target="=$session_name"

remote_dir_for_cd=$remote_dir
case $remote_dir_for_cd in
  /*) ;;
  *) remote_dir_for_cd="./$remote_dir_for_cd" ;;
esac

remote_ensemble=${ENSEMBLE_REMOTE_ENSEMBLE:-ensemble}

quote_shell_argument() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

tmux_command=("$remote_ensemble" issue "$issue_ref")
if (( extra_args_count > 0 )); then
  tmux_command+=("${extra_args[@]}")
fi
remote_new_session="tmux new-session -d -s $(quote_shell_argument "$session_name") -c \"\$PWD\""
for tmux_arg in "${tmux_command[@]}"; do
  remote_new_session+=" $(quote_shell_argument "$tmux_arg")"
done

remote_command="cd $(quote_shell_argument "$remote_dir_for_cd") || exit 1"
remote_command+=$'\nif tmux has-session -t '
remote_command+="$(quote_shell_argument "$session_target")"
remote_command+=' 2>/dev/null; then'
remote_command+=$'\n  :'
remote_command+=$'\nelif '
remote_command+="$remote_new_session"
remote_command+='; then'
remote_command+=$'\n  :'
remote_command+=$'\nelif tmux has-session -t '
remote_command+="$(quote_shell_argument "$session_target")"
remote_command+=' 2>/dev/null; then'
remote_command+=$'\n  :'
remote_command+=$'\nelse'
remote_command+=$'\n  exit 1'
remote_command+=$'\nfi'
remote_command+=$'\nprintf "%s\\n" '
remote_command+="$(quote_shell_argument "tmux session ready: $session_name")"
remote_command+=' >&2'

if [[ -t 0 && -t 1 ]]; then
  ssh_tty_flag=-t
  remote_command+=$'\nexec tmux attach-session -t '
  remote_command+="$(quote_shell_argument "$session_target")"
else
  ssh_tty_flag=-T
fi

ssh_host_index=$((${#ssh_args[@]} - 1))
ssh_command=()
for ((index = 0; index < ssh_host_index; index += 1)); do
  ssh_command+=("${ssh_args[$index]}")
done
ssh_command+=("$ssh_tty_flag" "$ssh_destination")

{
  printf 'tmux session: %s\n' "$session_name"
  printf 'Reconnect from a TTY with ENSEMBLE_REMOTE_SSH set by running: '
  quote_shell_argument "$0"
  printf ' '
  quote_shell_argument "$remote_dir"
  printf ' '
  quote_shell_argument "$issue_ref"
  printf '\n'
} >&2

exec "${ssh_command[@]}" "$remote_command"
