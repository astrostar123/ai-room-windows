@echo off
rem Puts an "AI Room" shortcut (with the robot icon) on your desktop.
cd /d "%~dp0"
powershell -NoProfile -Command "$s = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop') + '\AI Room.lnk'); $s.TargetPath = '%~dp0Start AI Room.bat'; $s.WorkingDirectory = '%~dp0'; $s.WindowStyle = 7; $s.IconLocation = '%~dp0ai-room.ico'; $s.Description = 'Pixel office for your Claude Code sessions'; $s.Save()"
if errorlevel 1 (
  echo Could not create the shortcut.
) else (
  echo Done! Look for "AI Room" on your desktop.
)
pause
