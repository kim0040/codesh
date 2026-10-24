param(
  [Parameter(Position = 0)][string]$Archive,
  [Parameter(Position = 1)][string]$Confirmation
)

$ErrorActionPreference = "Stop"
$global:CodeShScriptName = [System.IO.Path]::GetFileName($PSCommandPath)
. (Join-Path $PSScriptRoot "lib.ps1")
Set-Location $PSScriptRoot
$null = Get-CodeShDocker

if (-not $Archive -or -not (Test-Path -LiteralPath $Archive -PathType Leaf)) {
  Stop-CodeSh "usage: ./restore.ps1 <archive.gz> [--yes]"
}
if ($Confirmation -ne "--yes") {
  $answer = Read-Host "Replace the current codesh database with $Archive? [y/N]"
  if ($answer -cne "y" -and $answer -cne "Y") { Stop-CodeSh "cancelled" }
}

# api and collab write to the database; collab flushes open documents on stop.
Invoke-CodeShDocker -Arguments @("compose", "stop", "api", "collab")
$command = 'mongorestore --quiet --uri "mongodb://codesh:$MONGO_INITDB_ROOT_PASSWORD@localhost:27017/?authSource=admin" --archive --gzip --drop --nsInclude "codesh.*"'
Invoke-CodeShDockerStream -Arguments @("compose", "exec", "-T", "mongo", "sh", "-c", $command) -InputFile $Archive
Invoke-CodeShDocker -Arguments @("compose", "start", "api", "collab")
Wait-CodeShHealthy 120
Write-Output "restore: done"
