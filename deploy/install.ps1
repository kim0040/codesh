param()

$ErrorActionPreference = "Stop"
$global:CodeShScriptName = [System.IO.Path]::GetFileName($PSCommandPath)
. (Join-Path $PSScriptRoot "lib.ps1")
Set-Location $PSScriptRoot
$null = Get-CodeShDocker

if (-not (Test-Path -LiteralPath "images.tar" -PathType Leaf)) {
  Stop-CodeSh "images.tar is missing: run this from the extracted bundle"
}
$version = (Get-Content -LiteralPath "VERSION" -Raw -Encoding UTF8).Trim()

Write-Output "install: loading images ($version)"
Invoke-CodeShDocker -Arguments @("load", "-i", "images.tar")

if (Test-Path -LiteralPath ".env" -PathType Leaf) {
  Write-Output "install: keeping the existing .env"
} else {
  Copy-Item -LiteralPath ".env.example" -Destination ".env"
  foreach ($name in @("PUBLIC_URL", "HTTP_PORT", "HTTPS_PORT", "SITE_ADDRESS", "COLLAB_REPLICAS")) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if (-not [string]::IsNullOrEmpty($value)) { Set-CodeShEnvValue $name $value }
  }
}
Set-CodeShEnvValue "CODESH_VERSION" $version
& (Join-Path $PSScriptRoot "generate-secrets.ps1") ".env"
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { Stop-CodeSh "generate-secrets.ps1 failed" }
$global:CodeShScriptName = [System.IO.Path]::GetFileName($PSCommandPath)

Write-Output "install: starting"
Invoke-CodeShDocker -Arguments @("compose", "up", "-d", "--wait")
Wait-CodeShHealthy 120
$port = Get-CodeShEnvValue "HTTP_PORT" "80"
Write-Output "install: codesh $version is running on port $port"
Write-Output "install: back up with ./backup.ps1, upgrade with ./upgrade.ps1 <new bundle>"
