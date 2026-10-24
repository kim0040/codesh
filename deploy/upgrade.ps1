param([Parameter(Position = 0)][string]$Bundle)

$ErrorActionPreference = "Stop"
$global:CodeShScriptName = [System.IO.Path]::GetFileName($PSCommandPath)
. (Join-Path $PSScriptRoot "lib.ps1")
Set-Location $PSScriptRoot
$null = Get-CodeShDocker

if (-not $Bundle -or -not (Test-Path -LiteralPath $Bundle -PathType Leaf)) {
  Stop-CodeSh "usage: ./upgrade.ps1 <bundle.tar.gz>"
}
if (-not (Test-Path -LiteralPath ".env" -PathType Leaf)) {
  Stop-CodeSh "no .env here: this is not an installed codesh"
}
$bundlePath = (Resolve-Path -LiteralPath $Bundle).Path
$tar = Get-Command tar.exe -ErrorAction SilentlyContinue
if (-not $tar) { Stop-CodeSh "tar.exe is not installed" }
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString("N"))
$null = New-Item -ItemType Directory -Path $temporary
try {
  & $tar.Source -xzf $bundlePath -C $temporary
  if ($LASTEXITCODE -ne 0) { Stop-CodeSh "$Bundle is not a readable codesh bundle" }
  $images = Get-ChildItem -LiteralPath $temporary -Filter "images.tar" -File -Recurse | Select-Object -First 1
  if (-not $images) { Stop-CodeSh "$Bundle is not a codesh bundle" }
  $source = $images.Directory.FullName
  $version = (Get-Content -LiteralPath (Join-Path $source "VERSION") -Raw -Encoding UTF8).Trim()

  $currentVersion = Get-CodeShEnvValue "CODESH_VERSION"
  Write-Output "upgrade: $currentVersion -> $version"
  & (Join-Path $PSScriptRoot "backup.ps1") "./backups"
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { Stop-CodeSh "backup.ps1 failed" }
  $global:CodeShScriptName = [System.IO.Path]::GetFileName($PSCommandPath)
  Invoke-CodeShDocker -Arguments @("load", "-i", (Join-Path $source "images.tar"))

  foreach ($name in @("docker-compose.yml", ".env.example", "VERSION", "lib.sh", "lib.ps1", "generate-secrets.sh", "generate-secrets.ps1", "install.sh", "install.ps1", "upgrade.sh", "upgrade.ps1", "backup.sh", "backup.ps1", "restore.sh", "restore.ps1", "README.md")) {
    $newFile = Join-Path $source $name
    if (Test-Path -LiteralPath $newFile -PathType Leaf) {
      $destination = Join-Path $PSScriptRoot $name
      Copy-Item -LiteralPath $newFile -Destination "$destination.new" -Force
      Move-Item -LiteralPath "$destination.new" -Destination $destination -Force
    }
  }
  $sourceTls = Join-Path $source "tls"
  $targetTls = Join-Path $PSScriptRoot "tls"
  $null = New-Item -ItemType Directory -Path $targetTls -Force
  if (Test-Path -LiteralPath $sourceTls -PathType Container) {
    foreach ($file in (Get-ChildItem -LiteralPath $sourceTls -File -Force)) {
      $destination = Join-Path $targetTls $file.Name
      if (-not (Test-Path -LiteralPath $destination)) {
        Copy-Item -LiteralPath $file.FullName -Destination $destination
      }
    }
  }

  Set-CodeShEnvValue "CODESH_VERSION" $version
  foreach ($line in (Get-Content -LiteralPath (Join-Path $PSScriptRoot ".env.example") -Encoding UTF8)) {
    if ($line -cmatch '^([A-Z_]+)=') {
      $name = $Matches[1]
      $existing = Get-CodeShEnvLines | Where-Object { $_ -cmatch "^$([regex]::Escape($name))=" } | Select-Object -First 1
      if (-not $existing) {
        $default = ($line -split "=", 2)[1]
        Set-CodeShEnvValue $name $default
      }
    }
  }
  & (Join-Path $PSScriptRoot "generate-secrets.ps1") ".env"
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { Stop-CodeSh "generate-secrets.ps1 failed" }
  $global:CodeShScriptName = [System.IO.Path]::GetFileName($PSCommandPath)
  Invoke-CodeShDocker -Arguments @("compose", "up", "-d", "--wait")
  Wait-CodeShHealthy 120
  Write-Output "upgrade: codesh $version is running"
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
