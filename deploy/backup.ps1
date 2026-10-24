param([string]$Directory = "./backups")

$ErrorActionPreference = "Stop"
$global:CodeShScriptName = [System.IO.Path]::GetFileName($PSCommandPath)
. (Join-Path $PSScriptRoot "lib.ps1")
Set-Location $PSScriptRoot
$null = Get-CodeShDocker

$null = New-Item -ItemType Directory -Path $Directory -Force
$file = Join-Path $Directory ("codesh-{0}.archive.gz" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
$partial = "$file.part"
$command = 'mongodump --quiet --uri "mongodb://codesh:$MONGO_INITDB_ROOT_PASSWORD@localhost:27017/codesh?authSource=admin" --archive --gzip'
try {
  Invoke-CodeShDockerStream -Arguments @("compose", "exec", "-T", "mongo", "sh", "-c", $command) -OutputFile $partial
  $item = Get-Item -LiteralPath $partial
  if ($item.Length -eq 0) {
    Remove-Item -LiteralPath $partial -Force
    Stop-CodeSh "mongodump produced no data"
  }
  Move-Item -LiteralPath $partial -Destination $file -Force
  $length = (Get-Item -LiteralPath $file).Length
  Write-Output "backup: $file ($length bytes)"
} catch {
  if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
  throw
}
