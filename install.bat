@echo off
REM Proto-Familiar installer (Windows)
REM
REM Fresh install: installs Node deps, clones entity-core-alpha as a
REM   sibling directory, pre-caches its Deno module graph.
REM Update mode: triggered when node_modules\ already exists. Pulls
REM   latest Proto-Familiar via `git pull --ff-only`, refreshes
REM   entity-core to the pinned tag, re-runs idempotent npm install +
REM   deno cache. Skips Node/Deno install steps and shortcut creation.

setlocal EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
for %%I in ("%SCRIPT_DIR%\..") do set "PARENT_DIR=%%~fI"
set "ENTITY_CORE_DIR=%PARENT_DIR%\entity-core-alpha"
set "ENTITY_CORE_REPO=https://github.com/PsycherosAI/Psycheros.git"
set "ENTITY_CORE_TAG=entity-core-v0.2.2"

REM --- Detect mode ---
if exist "%SCRIPT_DIR%\node_modules" (
  set "MODE=update"
  echo === Proto-Familiar updater ^(existing install detected^) ===
) else (
  set "MODE=install"
  echo === Proto-Familiar installer ===
)
echo Working dir: %SCRIPT_DIR%
echo.

REM --- Pull latest Proto-Familiar (update mode only) ---
if "!MODE!"=="update" if exist "%SCRIPT_DIR%\.git" (
  where git >nul 2>nul
  if not errorlevel 1 (
    echo Pulling latest Proto-Familiar ^(git pull --ff-only^)...
    pushd "%SCRIPT_DIR%"
    git pull --ff-only
    if errorlevel 1 echo [WARN] git pull --ff-only failed. Continuing with current checkout.
    popd
  )
)

REM --- Node.js check ---
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Install Node 18+ from https://nodejs.org/ and re-run.
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if !NODE_MAJOR! LSS 18 (
  echo [ERROR] Node.js !NODE_MAJOR! detected. Proto-Familiar needs Node 18 or newer.
  pause
  exit /b 1
)
for /f %%v in ('node -v') do echo Node.js %%v found.

REM --- Deno check ---
where deno >nul 2>nul
if errorlevel 1 (
  echo [WARN] Deno not found. entity-core needs Deno 2+; install from https://deno.com/ if you want the identity layer.
) else (
  echo Deno found.
)

REM --- npm install (idempotent) ---
echo.
echo === Running npm install ===
pushd "%SCRIPT_DIR%"
call npm install
if errorlevel 1 (
  popd
  echo [ERROR] npm install failed.
  pause
  exit /b 1
)
popd

REM --- entity-core: clone (install) or refresh to pinned tag (update) ---
if exist "%ENTITY_CORE_DIR%" (
  if "!MODE!"=="update" if exist "%ENTITY_CORE_DIR%\.git" (
    where git >nul 2>nul
    if not errorlevel 1 (
      echo Refreshing entity-core-alpha to tag %ENTITY_CORE_TAG%...
      pushd "%ENTITY_CORE_DIR%"
      git fetch --tags --depth 1 origin refs/tags/%ENTITY_CORE_TAG%:refs/tags/%ENTITY_CORE_TAG% >nul 2>nul
      git checkout --quiet %ENTITY_CORE_TAG%
      if errorlevel 1 echo [WARN] Could not refresh entity-core to %ENTITY_CORE_TAG%. Keeping current checkout.
      popd
    )
  ) else (
    echo entity-core-alpha already present at %ENTITY_CORE_DIR% - skipping clone.
  )
) else (
  where git >nul 2>nul
  if errorlevel 1 (
    echo [WARN] git not found - skipping entity-core clone. Install git or place entity-core-alpha at %ENTITY_CORE_DIR% manually.
  ) else (
    echo Cloning entity-core-alpha into %ENTITY_CORE_DIR% ...
    git clone --depth 1 --branch %ENTITY_CORE_TAG% %ENTITY_CORE_REPO% "%ENTITY_CORE_DIR%"
    if errorlevel 1 (
      echo [WARN] Tag clone failed; falling back to default branch.
      git clone --depth 1 %ENTITY_CORE_REPO% "%ENTITY_CORE_DIR%"
    )
  )
)

REM --- entity-core dependency pre-cache (idempotent) ---
set "ENTITY_CORE_PKG="
if exist "%ENTITY_CORE_DIR%\packages\entity-core\src\mod.ts" (
  set "ENTITY_CORE_PKG=%ENTITY_CORE_DIR%\packages\entity-core"
) else if exist "%ENTITY_CORE_DIR%\src\mod.ts" (
  set "ENTITY_CORE_PKG=%ENTITY_CORE_DIR%"
)
where deno >nul 2>nul
if not errorlevel 1 if defined ENTITY_CORE_PKG (
  echo Caching entity-core dependencies ^(only fetches what's new^)...
  pushd "%ENTITY_CORE_PKG%"
  deno cache src/mod.ts >nul 2>nul
  if errorlevel 1 (
    echo [WARN] deno cache failed - first server start will download deps before entity-core comes up.
  ) else (
    echo entity-core dependencies cached.
  )
  popd
)

echo.
if "!MODE!"=="update" (
  echo === Update complete ===
) else (
  echo === Install complete ===
)
echo   Start: start.bat   ^(double-click^)
echo   Stop:  stop.bat    ^(double-click^)
echo.
pause
endlocal
