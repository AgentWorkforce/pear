$ErrorActionPreference = "Stop"

$Repo = if ($env:PEAR_RELEASE_REPO) { $env:PEAR_RELEASE_REPO } else { "AgentWorkforce/pear" }
$BaseUrl = if ($env:PEAR_RELEASE_BASE_URL) {
  $env:PEAR_RELEASE_BASE_URL.TrimEnd("/")
} else {
  "https://github.com/$Repo/releases/latest/download"
}

if (-not [Environment]::Is64BitOperatingSystem) {
  throw "Pear currently publishes a Windows x64 installer only."
}

$Artifact = "Pear-win-x64.exe"
$Url = "$BaseUrl/$Artifact"
$Output = Join-Path $env:TEMP $Artifact

Write-Host "Downloading $Url"
Invoke-WebRequest -Uri $Url -OutFile $Output

Write-Host "Starting Pear installer"
Start-Process -FilePath $Output -Wait
