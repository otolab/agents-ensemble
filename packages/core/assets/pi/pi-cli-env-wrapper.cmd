@echo off
setlocal

if not defined ENSEMBLE_PI_CLI_NODE (
  echo [acp] builtin Pi Node.js executable was not configured 1>&2
  exit /b 1
)
if not defined ENSEMBLE_PI_CLI_EXECUTABLE (
  echo [acp] builtin Pi CLI was not configured 1>&2
  exit /b 1
)
if not defined ENSEMBLE_PI_CLI_HOME (
  echo [acp] builtin Pi CLI HOME was not configured 1>&2
  exit /b 1
)

set "piNode=%ENSEMBLE_PI_CLI_NODE%"
set "piCli=%ENSEMBLE_PI_CLI_EXECUTABLE%"
set "HOME=%ENSEMBLE_PI_CLI_HOME%"
set "USERPROFILE=%ENSEMBLE_PI_CLI_USERPROFILE%"
set "ENSEMBLE_PI_CLI_NODE="
set "ENSEMBLE_PI_CLI_EXECUTABLE="
set "ENSEMBLE_PI_CLI_HOME="
set "ENSEMBLE_PI_CLI_USERPROFILE="
set "PI_ACP_PI_COMMAND="

"%piNode%" "%piCli%" %*
exit /b %ERRORLEVEL%
