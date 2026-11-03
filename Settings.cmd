@echo off
rem Opens the screensaver's settings page: starts its server without a console window, or only opens
rem the page when the server already runs. The server stops by itself once no page is open.
where pythonw >nul 2>nul && (start "" pythonw "%~dp0tools\settings.py" %*) || (start "" pyw "%~dp0tools\settings.py" %*)
