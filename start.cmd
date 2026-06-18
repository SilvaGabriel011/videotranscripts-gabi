@echo off
rem YouTube Transcript Extractor - launcher (Windows)
rem DUPLO-CLIQUE para subir o app e abrir o navegador.
rem Na 1a vez instala as dependencias automaticamente.

cd /d "%~dp0"

echo == YouTube Transcript Extractor ==

if not exist "node_modules\" call :setup
if not exist ".env" call :setup

rem Abre o navegador depois de alguns segundos, em paralelo ao servidor.
start "" cmd /c "timeout /t 6 >nul & start http://localhost:3000"

echo.
echo Subindo o servidor... o navegador abre em http://localhost:3000
echo (Para encerrar: feche esta janela ou pressione Ctrl-C)
echo.

npm run web
goto :eof

:setup
echo Primeira execucao: instalando dependencias...
powershell -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
goto :eof
