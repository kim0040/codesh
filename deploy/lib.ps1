# Shared helpers for the Windows PowerShell deployment scripts.

function Stop-CodeSh {
  param([Parameter(Mandatory = $true)][string]$Message)

  [Console]::Error.WriteLine("$global:CodeShScriptName`: $Message")
  exit 1
}

function Get-CodeShDocker {
  $docker = Get-Command docker -ErrorAction SilentlyContinue
  if (-not $docker) { Stop-CodeSh "docker is not installed" }
  $null = & $docker.Source compose version 2>$null
  if ($LASTEXITCODE -ne 0) { Stop-CodeSh "the docker compose plugin is missing" }
  return $docker.Source
}

function Invoke-CodeShDocker {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  $null = Get-CodeShDocker
  & docker @Arguments
  if ($LASTEXITCODE -ne 0) { Stop-CodeSh "docker $($Arguments -join ' ') failed" }
}

function Get-CodeShEnvLines {
  if (-not (Test-Path -LiteralPath ".env" -PathType Leaf)) { return @() }
  return @(Get-Content -LiteralPath ".env" -Encoding UTF8)
}

function Write-CodeShEnvLines {
  param([Parameter(Mandatory = $true)][string[]]$Lines)

  $content = if ($Lines.Count -eq 0) { "" } else { [string]::Join("`n", $Lines) + "`n" }
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText((Join-Path (Get-Location) ".env"), $content, $encoding)
}

function Get-CodeShEnvValue {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$Default = ""
  )

  $value = $Default
  foreach ($line in (Get-CodeShEnvLines)) {
    if ($line -cmatch "^$([regex]::Escape($Name))=(.*)$") { $value = $Matches[1] }
  }
  if ([string]::IsNullOrEmpty($value)) { return $Default }
  return $value
}

function Set-CodeShEnvValue {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value
  )

  $lines = New-Object 'System.Collections.Generic.List[string]'
  foreach ($line in (Get-CodeShEnvLines)) { $lines.Add($line) }
  $pattern = "^$([regex]::Escape($Name))=.*$"
  $found = $false
  for ($index = 0; $index -lt $lines.Count; $index++) {
    if ($lines[$index] -cmatch $pattern) {
      $lines[$index] = "$Name=$Value"
      $found = $true
    }
  }
  if (-not $found) { $lines.Add("$Name=$Value") }
  Write-CodeShEnvLines -Lines $lines.ToArray()
}

function Set-CodeShFilePermissions {
  param([Parameter(Mandatory = $true)][string]$Path)

  if ($env:OS -eq "Windows_NT") {
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, $allow))
    Set-Acl -LiteralPath $Path -AclObject $acl
    return
  }

  # This branch keeps the script testable with pwsh on Linux; PowerShell 5.1 only uses the ACL path.
  $method = [System.IO.File].GetMethods() | Where-Object {
    $_.Name -eq "SetUnixFileMode" -and $_.GetParameters().Count -eq 2 -and
      $_.GetParameters()[0].ParameterType -eq [string]
  } | Select-Object -First 1
  if ($method) {
    $modeType = $method.GetParameters()[1].ParameterType
    $mode = [System.Enum]::Parse($modeType, "UserRead, UserWrite")
    [System.IO.File]::SetUnixFileMode([System.IO.Path]::GetFullPath($Path), $mode)
  }
}

function Wait-CodeShHealthy {
  param([int]$Seconds = 120)

  $port = Get-CodeShEnvValue "HTTP_PORT" "80"
  $url = "http://127.0.0.1:$port/healthz"
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $null = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
      return
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  [Console]::Error.WriteLine("no healthy answer from $url within ${Seconds}s; recent logs:")
  & docker compose logs --tail 20 2>&1 | ForEach-Object { [Console]::Error.WriteLine($_) }
  exit 1
}

function ConvertTo-CodeShCommandLineArgument {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append('"')
  $slashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') {
      $slashes++
      continue
    }
    if ($character -eq '"') {
      [void]$builder.Append(('\' * (2 * $slashes + 1)))
      [void]$builder.Append('"')
      $slashes = 0
      continue
    }
    if ($slashes -gt 0) { [void]$builder.Append(('\' * $slashes)); $slashes = 0 }
    [void]$builder.Append($character)
  }
  if ($slashes -gt 0) {
    for ($index = 0; $index -lt (2 * $slashes); $index++) { [void]$builder.Append('\') }
  }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Invoke-CodeShDockerStream {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [string]$InputFile,
    [string]$OutputFile
  )

  $docker = Get-CodeShDocker
  $quoted = foreach ($argument in $Arguments) { ConvertTo-CodeShCommandLineArgument $argument }
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $docker
  $info.WorkingDirectory = (Get-Location).Path
  $info.Arguments = [string]::Join(" ", $quoted)
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardInput = -not [string]::IsNullOrEmpty($InputFile)
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $info
  [void]$process.Start()

  $output = $null
  if (-not [string]::IsNullOrEmpty($OutputFile)) {
    $output = [System.IO.File]::Create($OutputFile)
  }
  try {
    if ($InputFile) {
      $input = [System.IO.File]::OpenRead($InputFile)
      try { $input.CopyTo($process.StandardInput.BaseStream) } finally { $input.Dispose(); $process.StandardInput.Close() }
    }
    if ($output) { $process.StandardOutput.BaseStream.CopyTo($output) }
    else { $process.StandardOutput.BaseStream.CopyTo([System.IO.Stream]::Null) }
  } finally {
    if ($output) { $output.Dispose() }
  }
  $process.WaitForExit()
  $exitCode = $process.ExitCode
  $process.Dispose()
  if ($exitCode -ne 0) { Stop-CodeSh "docker $($Arguments -join ' ') failed" }
}
