#!/bin/sh
set -eu

pi_node=${ENSEMBLE_PI_CLI_NODE:?builtin Pi Node.js executable was not configured}
pi_cli=${ENSEMBLE_PI_CLI_EXECUTABLE:?builtin Pi CLI was not configured}
pi_home=${ENSEMBLE_PI_CLI_HOME:?builtin Pi CLI HOME was not configured}
pi_userprofile=${ENSEMBLE_PI_CLI_USERPROFILE:-$pi_home}

HOME=$pi_home
USERPROFILE=$pi_userprofile
export HOME USERPROFILE

unset ENSEMBLE_PI_CLI_NODE
unset ENSEMBLE_PI_CLI_EXECUTABLE
unset ENSEMBLE_PI_CLI_HOME
unset ENSEMBLE_PI_CLI_USERPROFILE
unset PI_ACP_PI_COMMAND

exec "$pi_node" "$pi_cli" "$@"
