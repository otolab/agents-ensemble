#!/usr/bin/env bash
# Start or reattach to a remote `ensemble issue` session in tmux.
#
# Usage:
#   ENSEMBLE_REMOTE_SSH='ssh -J bastion user@host' \
#     scripts/remote-ensemble-issue.sh /path/to/repo 42 -- --profile team
#
# ENSEMBLE_REMOTE_SSH uses shell-like quotes for argv grouping, but is never
# evaluated as shell code. OpenSSH-compatible commands put the destination
# last; gcloud compute ssh is handled with its --command/--ssh-flag options.

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
  ENSEMBLE_REMOTE_SSH       Required; SSH command and args. Single/double
                            quotes group words; shell expansion is not run.
                            Supports OpenSSH-compatible clients and
                            `gcloud compute ssh` (including alpha/beta).
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

parse_ssh_arguments() {
  local input=$1
  local current='' quote='' char
  local token_started=0 escaped=0 index=0 input_length=${#1}
  ssh_args=()

  while (( index < input_length )); do
    char=${input:index:1}
    if (( escaped )); then
      current+=$char
      token_started=1
      escaped=0
    elif [[ $quote == "'" ]]; then
      if [[ $char == "'" ]]; then
        quote=''
      else
        current+=$char
      fi
      token_started=1
    elif [[ $quote == '"' ]]; then
      case $char in
        '"')
          quote=''
          ;;
        \\)
          index=$((index + 1))
          if (( index >= input_length )); then
            return 1
          fi
          char=${input:index:1}
          case $char in
            '"'|\\|'$'|'`')
              current+=$char
              ;;
            *)
              current+="\\$char"
              ;;
          esac
          ;;
        *)
          current+=$char
          ;;
      esac
      token_started=1
    else
      case $char in
        "'")
          quote="'"
          token_started=1
          ;;
        '"')
          quote='"'
          token_started=1
          ;;
        \\)
          escaped=1
          token_started=1
          ;;
        ' '|$'\t')
          if (( token_started )); then
            ssh_args+=("$current")
            current=''
            token_started=0
          fi
          ;;
        *)
          current+=$char
          token_started=1
          ;;
      esac
    fi
    index=$((index + 1))
  done

  if [[ -n $quote ]] || (( escaped )); then
    return 1
  fi
  if (( token_started )); then
    ssh_args+=("$current")
  fi
}

if ! parse_ssh_arguments "$ENSEMBLE_REMOTE_SSH"; then
  fail_usage 'ENSEMBLE_REMOTE_SSH has unmatched quotes or a trailing backslash'
fi

if (( ${#ssh_args[@]} < 2 )); then
  fail_usage 'ENSEMBLE_REMOTE_SSH must include an SSH command and destination'
fi

remote_transport=openssh
ssh_command_name=${ssh_args[0]##*/}
if [[ $ssh_command_name == gcloud ]]; then
  case ${ssh_args[1]:-} in
    compute)
      if [[ ${ssh_args[2]:-} == ssh ]]; then
        remote_transport=gcloud
      else
        fail_usage 'gcloud command must be `gcloud compute ssh`'
      fi
      ;;
    alpha|beta)
      if [[ ${ssh_args[2]:-} == compute && ${ssh_args[3]:-} == ssh ]]; then
        remote_transport=gcloud
      else
        fail_usage 'gcloud command must be `gcloud [alpha|beta] compute ssh`'
      fi
      ;;
    *)
      fail_usage 'gcloud command must be `gcloud compute ssh`'
      ;;
  esac
fi

for ((index = 0; index < ${#ssh_args[@]}; index += 1)); do
  ssh_arg=${ssh_args[$index]}
  case $ssh_arg in
    -t|-tt|-ttt|-T|--ssh-flag=-t|--ssh-flag=-tt|--ssh-flag=-ttt|--ssh-flag=-T)
      fail_usage 'do not set SSH -t/-T; TTY allocation is selected automatically'
      ;;
    --ssh-flag)
      next_index=$((index + 1))
      if (( next_index < ${#ssh_args[@]} )); then
        case ${ssh_args[$next_index]} in
          -t|-tt|-ttt|-T)
            fail_usage 'do not set SSH -t/-T; TTY allocation is selected automatically'
            ;;
        esac
      fi
      ;;
    --command|--command=*)
      if [[ $remote_transport == gcloud ]]; then
        fail_usage 'do not set gcloud --command; the remote command is supplied by this script'
      fi
      ;;
  esac
done

if [[ $remote_transport == openssh ]]; then
  ssh_destination=${ssh_args[$((${#ssh_args[@]} - 1))]}
  if [[ -z $ssh_destination || $ssh_destination == -* ]]; then
    fail_usage 'the SSH destination must be the final word in ENSEMBLE_REMOTE_SSH'
  fi
fi

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

remote_command="cd $(quote_shell_argument "$remote_dir_for_cd") || exit 1"
remote_command+=$'\nremote_executable_available() {'
remote_command+=$'\n  case '
remote_command+="$(quote_shell_argument "$remote_ensemble")"
remote_command+=$' in'
remote_command+=$'\n    */*) [ -f '
remote_command+="$(quote_shell_argument "$remote_ensemble")"
remote_command+=' ] && [ -x '
remote_command+="$(quote_shell_argument "$remote_ensemble")"
remote_command+=' ] ;;'
remote_command+=$'\n    *) command -v '
remote_command+="$(quote_shell_argument "$remote_ensemble")"
remote_command+=' >/dev/null 2>&1 ;;'
remote_command+=$'\n  esac'
remote_command+=$'\n}'
remote_command+=$'\npane_is_running() {'
remote_command+=$'\n  pane_states=$(tmux list-panes -t '
remote_command+="$(quote_shell_argument "$session_target")"
remote_command+=" -F '#{pane_dead}' 2>/dev/null) || return 1"
remote_command+=$'\n  case $pane_states in'
remote_command+=$'\n    *0*) return 0 ;;'
remote_command+=$'\n    *) return 1 ;;'
remote_command+=$'\n  esac'
remote_command+=$'\n}'
remote_command+=$'\nif tmux has-session -t '
remote_command+="$(quote_shell_argument "$session_target")"
remote_command+=' 2>/dev/null; then'
remote_command+=$'\n  :'
remote_command+=$'\nelse'
remote_command+=$'\n  if ! remote_executable_available; then'
remote_command+=$'\n    printf "%s\\n" '
remote_command+="$(quote_shell_argument "remote executable not found or not executable: $remote_ensemble")"
remote_command+=' >&2'
remote_command+=$'\n    printf "%s\\n" '
remote_command+="$(quote_shell_argument 'Set ENSEMBLE_REMOTE_ENSEMBLE to an executable remote path.')"
remote_command+=' >&2'
remote_command+=$'\n    printf "%s\\n" '
remote_command+="$(quote_shell_argument 'For Node version managers, make node available in the tmux pane PATH too.')"
remote_command+=' >&2'
remote_command+=$'\n    exit 127'
remote_command+=$'\n  fi'
remote_command+=$'\n  if tmux new-session -d -s '
remote_command+="$(quote_shell_argument "$session_name")"
remote_command+=' -c "$PWD"'
for tmux_arg in "${tmux_command[@]}"; do
  remote_command+=" $(quote_shell_argument "$tmux_arg")"
done
remote_command+=' 2>/dev/null; then'
remote_command+=$'\n    :'
remote_command+=$'\n  elif ! tmux has-session -t '
remote_command+="$(quote_shell_argument "$session_target")"
remote_command+=' 2>/dev/null; then'
remote_command+=$'\n    printf "%s\\n" '
remote_command+="$(quote_shell_argument "could not create tmux session: $session_name")"
remote_command+=' >&2'
remote_command+=$'\n    exit 1'
remote_command+=$'\n  fi'
remote_command+=$'\nfi'
# A concurrent invocation can observe a newly created session before its pane
# command has finished starting. Check after a short grace period on every path.
remote_command+=$'\nsleep 1'
remote_command+=$'\nif ! tmux has-session -t '
remote_command+="$(quote_shell_argument "$session_target")"
remote_command+=' 2>/dev/null || ! pane_is_running; then'
remote_command+=$'\n  printf "%s\\n" '
remote_command+="$(quote_shell_argument "tmux session did not keep a running pane: $session_name")"
remote_command+=' >&2'
remote_command+=$'\n  printf "%s\\n" '
remote_command+="$(quote_shell_argument "Check the executable's runtime interpreter (such as node) and the tmux pane PATH.")"
remote_command+=' >&2'
remote_command+=$'\n  exit 1'
remote_command+=$'\nfi'
remote_command+=$'\nprintf "%s\\n" '
remote_command+="$(quote_shell_argument "tmux session ready: $session_name")"
remote_command+=' >&2'
remote_command+=$'\nprintf "%s\\n" '
remote_command+="$(quote_shell_argument "tmux session: $session_name")"
remote_command+=' >&2'
remote_command+=$'\nprintf "%s\\n" '
remote_command+="$(quote_shell_argument "Reconnect from a TTY with ENSEMBLE_REMOTE_SSH set by running:")"
remote_command+=' >&2'
remote_command+=$'\nprintf "%s %s %s\\n" '
remote_command+="$(quote_shell_argument "$0")"
remote_command+=' '
remote_command+="$(quote_shell_argument "$remote_dir")"
remote_command+=' '
remote_command+="$(quote_shell_argument "$issue_ref")"
remote_command+=' >&2'

if [[ -t 0 && -t 1 ]]; then
  ssh_tty_flag=-t
  remote_command+=$'\nexec tmux attach-session -t '
  remote_command+="$(quote_shell_argument "$session_target")"
else
  ssh_tty_flag=-T
fi

ssh_command=()
if [[ $remote_transport == gcloud ]]; then
  ssh_separator_index=${#ssh_args[@]}
  for ((index = 0; index < ${#ssh_args[@]}; index += 1)); do
    if [[ ${ssh_args[$index]} == -- ]]; then
      ssh_separator_index=$index
      break
    fi
  done

  for ((index = 0; index < ssh_separator_index; index += 1)); do
    ssh_command+=("${ssh_args[$index]}")
  done
  ssh_command+=("--command=$remote_command" "--ssh-flag=$ssh_tty_flag")
  if (( ssh_separator_index < ${#ssh_args[@]} )); then
    ssh_command+=(--)
    for ((index = ssh_separator_index + 1; index < ${#ssh_args[@]}; index += 1)); do
      ssh_command+=("${ssh_args[$index]}")
    done
  fi
else
  ssh_host_index=$((${#ssh_args[@]} - 1))
  for ((index = 0; index < ssh_host_index; index += 1)); do
    ssh_command+=("${ssh_args[$index]}")
  done
  ssh_command+=("$ssh_tty_flag" "$ssh_destination" "$remote_command")
fi

exec "${ssh_command[@]}"
