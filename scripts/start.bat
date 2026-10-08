@echo off
echo ============================================
echo  Enterprise Chatbot - Windows Startup
echo ============================================
echo.

REM Check Docker
docker --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker is not installed or not running.
    echo Please install Docker Desktop from https://www.docker.com/products/docker-desktop
    pause
    exit /b 1
)

REM Check docker-compose
docker compose version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker Compose not available.
    pause
    exit /b 1
)

REM Create .env if missing
if not exist ".env" (
    echo [INFO] Creating .env from .env.example...
    copy .env.example .env
    echo [WARN] .env created. Edit it and add your OPENAI_API_KEY before continuing.
    echo.
    notepad .env
)

echo [INFO] Building and starting services...
docker compose up --build -d

echo.
echo [INFO] Waiting for services to be ready...
timeout /t 15 /nobreak >nul

echo.
echo ============================================
echo  Services started!
echo ============================================
echo  Frontend  : http://localhost:3000
echo  Backend   : http://localhost:8000
echo  API Docs  : http://localhost:8000/api/docs
echo  Admin     : admin@example.com / Admin@123
echo ============================================
echo.
pause
