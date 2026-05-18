' Proto-Familiar - double-click launcher (Windows)
' Runs install on first launch, then starts the system-tray app with no console window.
Option Explicit

Dim sh, fso, scriptDir, nodeModules, unruhPyproject, unruhVenv, installPs1, trayPs1, needInstall
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeModules    = scriptDir & "\node_modules"
unruhPyproject = scriptDir & "\unruh\pyproject.toml"
unruhVenv      = scriptDir & "\unruh\.venv"
installPs1     = scriptDir & "\scripts\win\install.ps1"
trayPs1        = scriptDir & "\scripts\win\tray.ps1"

' Trigger install on first run OR after a git pull that introduces Unruh.
' Symmetric to start.bat / start.sh: a missing unruh\.venv with present
' unruh\pyproject.toml means deps haven't been materialised yet.
needInstall = False
If Not fso.FolderExists(nodeModules) Then needInstall = True
If fso.FileExists(unruhPyproject) And Not fso.FolderExists(unruhVenv) Then needInstall = True

If needInstall Then
  sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & installPs1 & """", 1, True
End If

' Launch the tray app fully hidden. The user only sees the tray icon.
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & trayPs1 & """", 0, False
