@echo off
setlocal

set "LAUNCHER_DIR=%~dp0"
set "MCP_SCRIPT=%LAUNCHER_DIR%node_modules\agent-relay\dist\cli\agent-relay-mcp.js"

if not exist "%MCP_SCRIPT%" (
  echo Agent Relay MCP script not found: "%MCP_SCRIPT%" 1>&2
  exit /b 1
)

set "APP_ROOT=%LAUNCHER_DIR%..\.."
set "ELECTRON_EXE="

if exist "%APP_ROOT%\Pear by Agent Relay.exe" (
  set "ELECTRON_EXE=%APP_ROOT%\Pear by Agent Relay.exe"
) else (
  for %%F in ("%APP_ROOT%\*.exe") do (
    if /I not "%%~nxF"=="Uninstall Pear by Agent Relay.exe" (
      set "ELECTRON_EXE=%%~fF"
      goto :found_exe
    )
  )
)

:found_exe
if not defined ELECTRON_EXE (
  echo Pear executable not found relative to launcher: "%LAUNCHER_DIR%" 1>&2
  exit /b 1
)

set "ELECTRON_RUN_AS_NODE=1"
"%ELECTRON_EXE%" "%MCP_SCRIPT%" %*
