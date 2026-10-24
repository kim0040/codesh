param([string]$Path = ".env")

$ErrorActionPreference = "Stop"
$global:CodeShScriptName = [System.IO.Path]::GetFileName($PSCommandPath)
. (Join-Path $PSScriptRoot "lib.ps1")
Set-Location $PSScriptRoot

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
  if (-not (Test-Path -LiteralPath ".env.example" -PathType Leaf)) {
    Stop-CodeSh "$Path and .env.example are missing"
  }
  Copy-Item -LiteralPath ".env.example" -Destination $Path
}

$secrets = @("SESSION_SECRET", "COLLAB_SECRET", "ADMIN_TOKEN", "MONGO_PASSWORD", "VALKEY_PASSWORD")
$lines = New-Object 'System.Collections.Generic.List[string]'
foreach ($line in (Get-Content -LiteralPath $Path -Encoding UTF8)) { $lines.Add($line) }
$filled = New-Object 'System.Collections.Generic.List[string]'
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  foreach ($name in $secrets) {
    $pattern = "^$([regex]::Escape($name))="
    $found = $false
    for ($index = 0; $index -lt $lines.Count; $index++) {
      if ($lines[$index] -cmatch $pattern) {
        $found = $true
        if ($lines[$index] -cmatch "^$([regex]::Escape($name))=\s*$") {
          $bytes = New-Object byte[] 32
          $rng.GetBytes($bytes)
          $value = [System.BitConverter]::ToString($bytes).Replace("-", "").ToLowerInvariant()
          $lines[$index] = "$name=$value"
          $filled.Add($name)
        }
      }
    }
    if (-not $found) {
      $bytes = New-Object byte[] 32
      $rng.GetBytes($bytes)
      $value = [System.BitConverter]::ToString($bytes).Replace("-", "").ToLowerInvariant()
      $lines.Add("$name=$value")
      $filled.Add($name)
    }
  }
} finally {
  $rng.Dispose()
}

$encoding = New-Object System.Text.UTF8Encoding($false)
$content = if ($lines.Count -eq 0) { "" } else { [string]::Join("`n", $lines) + "`n" }
$envPath = [System.IO.Path]::GetFullPath($Path)
[System.IO.File]::WriteAllText($envPath, $content, $encoding)
Set-CodeShFilePermissions -Path $envPath
if ($filled.Count -gt 0) {
  Write-Output "generate-secrets: wrote $($filled -join ' ') to $Path"
} else {
  Write-Output "generate-secrets: $Path already has all secrets"
}
