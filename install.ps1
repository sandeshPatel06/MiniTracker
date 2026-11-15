# get-Hike PowerShell Installer for Windows (x64)
$ErrorActionPreference = "Stop"

$AppName = "get-Hike"
$Repo = "sandeshPatel06/MiniTracker"
$InstallDir = "$env:LOCALAPPDATA\get-hike"
$BinName = "get-hike-windows-amd64.exe"
$TargetExe = "$InstallDir\get-hike.exe"
$DownloadUrl = "https://github.com/$Repo/releases/latest/download/$BinName"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Installing $AppName on Windows" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan

# Create Directory
if (!(Test-Path -Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# Download Binary
Write-Host "Downloading latest release from GitHub..." -ForegroundColor Yellow
try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $TargetExe -UseBasicParsing
    Write-Host "[OK] Binary downloaded to $TargetExe" -ForegroundColor Green
} catch {
    Write-Host "[FAIL] Failed to download from $DownloadUrl" -ForegroundColor Red
    Write-Host "Falling back to release catalog..." -ForegroundColor Yellow
    exit 1
}

# Create Desktop Shortcut
$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Desktop)
$ShortcutPath = "$DesktopPath\$AppName.lnk"
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $TargetExe
$Shortcut.WorkingDirectory = $InstallDir
$Shortcut.Description = "Privacy-first productivity and focus tracker"
$Shortcut.Save()
Write-Host "[OK] Desktop shortcut created at $ShortcutPath" -ForegroundColor Green

# Add to User PATH if not already present
$UserPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
    [System.Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    Write-Host "[OK] Added $InstallDir to user PATH" -ForegroundColor Green
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  $AppName installed successfully!" -ForegroundColor Green
Write-Host "  Launch from Desktop or run: get-hike" -ForegroundColor Yellow
Write-Host "==========================================" -ForegroundColor Cyan
