@echo off
title Portal Imperial - Caja
color 0E
echo.
echo  ========================================
echo     PORTAL IMPERIAL - ESTACION DE CAJA
echo  ========================================
echo.
echo  Iniciando el sistema local...
echo  NO CIERRE ESTA VENTANA mientras trabaja.
echo.

cd /d "%~dp0"

REM Intentar con python, si no con py
where python >nul 2>nul
if %errorlevel%==0 (
    start "" http://localhost:9753
    python -m http.server 9753
    goto fin
)

where py >nul 2>nul
if %errorlevel%==0 (
    start "" http://localhost:9753
    py -m http.server 9753
    goto fin
)

echo  ERROR: No se encontro Python instalado.
echo  Por favor instale Python desde: https://www.python.org/downloads/
echo  Y marque la casilla "Add Python to PATH" durante la instalacion.
echo.
pause

:fin
