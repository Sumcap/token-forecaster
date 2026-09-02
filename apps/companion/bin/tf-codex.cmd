@echo off
rem Windows entry point for the draft-aware Codex launcher.
rem
rem `bin/tf-codex` is a Python program with a `#!` line, which Windows does not
rem read: something has to find an interpreter and hand it the script. That is
rem all this file is. It is also the path written into the PowerShell profile,
rem because a shell block has to name a file the console can execute.
rem
rem Every failure here ends the same way -- by starting Codex unchanged.
rem Losing the forecast is a bad afternoon; losing `codex` is a broken machine.
setlocal
set "TF_SCRIPT=%~dp0tf-codex"
set "TF_PY="

if not exist "%TF_SCRIPT%" goto :fallback

if defined TOKEN_FORECASTER_PYTHON (
  set "TF_PY=%TOKEN_FORECASTER_PYTHON%"
  goto :run
)

rem The py launcher ships with python.org installs and picks the newest 3.x;
rem `python` is what the Microsoft Store and most other installs leave on PATH.
where py >nul 2>&1 && set "TF_PY=py -3"
if not defined TF_PY where python >nul 2>&1 && set "TF_PY=python"
if not defined TF_PY goto :nopython

:run
%TF_PY% "%TF_SCRIPT%" %*
exit /b %errorlevel%

:nopython
>&2 echo tf-codex: no Python 3 on PATH, so this session has no draft forecast.
>&2 echo            Install Python 3 from python.org, or set TOKEN_FORECASTER_PYTHON.

:fallback
codex %*
exit /b %errorlevel%
