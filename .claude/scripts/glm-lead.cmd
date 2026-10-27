@echo off
REM glm-lead.cmd — Windows CMD launcher for a GLM-5.2 lead Claude Code session.
REM Thin wrapper: calls the verified glm-lead.sh through Git Bash, so there is ONE
REM source of truth (the .sh) and no env-parsing duplicated in batch.
REM
REM Use when your Opus limit is out and you want GLM "instead of Claude" right here:
REM   double-click this file, OR from any CMD/Explorer:  .claude\scripts\glm-lead.cmd
REM   one-shot:                                          .claude\scripts\glm-lead.cmd -p "task"
REM   startup self-test:                                 .claude\scripts\glm-lead.cmd --smoke
setlocal
set "BASH=C:\Program Files\Git\bin\bash.exe"
if not exist "%BASH%" set "BASH=C:\Program Files\Git\usr\bin\bash.exe"
if not exist "%BASH%" (
  echo Could not find Git Bash. Install Git for Windows, or run the .sh from Git Bash directly.
  exit /b 1
)
"%BASH%" "%~dp0glm-lead.sh" %*
endlocal
