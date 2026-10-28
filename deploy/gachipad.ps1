[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$ScriptName,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$ScriptArgs = @(),
    [switch]$WrapperNoRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install.ps1') -NoRun

function Invoke-GachipadCommand {
    param(
        [string]$Name,
        [string[]]$Arguments = @()
    )

    if ([string]::IsNullOrWhiteSpace($Name)) {
        throw 'Usage: .\gachipad.ps1 <script> [arguments], or .\gachipad.ps1 logs.'
    }
    $statePath = Get-InstallStatePath
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        throw "No saved installation was found at $statePath. Run install.cmd or install.ps1 first."
    }
    try {
        $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -eq $state -or $null -eq $state.PSObject.Properties['Distro'] -or
            $null -eq $state.PSObject.Properties['InstallDir'] -or
            $state.Distro -isnot [string] -or $state.InstallDir -isnot [string] -or
            [string]::IsNullOrWhiteSpace($state.Distro) -or [string]::IsNullOrWhiteSpace($state.InstallDir) -or
            ($null -ne $state.PSObject.Properties['Version'] -and $state.Version -ne 1)) {
            throw 'Invalid installation state.'
        }
    } catch {
        throw "The saved installation file is invalid: $statePath. Run install.ps1 again to save the WSL location."
    }

    if ($Name -eq 'logs') {
        $wslArguments = @('-d', [string]$state.Distro, '--cd', [string]$state.InstallDir, '--exec', 'docker', 'compose', 'logs', '-f') + $Arguments
        $result = Invoke-Wsl -Arguments $wslArguments -PassThruConsole
        if ($result.ExitCode -ne 0) { throw "docker compose logs exited with code $($result.ExitCode)." }
        return
    }

    $normalizedName = $Name -replace '\.sh$', ''
    if ($normalizedName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
        throw "Invalid script name '$Name'. Pass a script name such as update or backup, without a path."
    }
    if ($normalizedName -eq 'lib') { throw 'lib.sh is a helper and cannot be run directly.' }
    $listScript = @'
set -eu
cd "$1"
find . -maxdepth 1 -type f -name '*.sh' -printf '%f\n'
'@
    $list = Invoke-WslScript -SelectedDistro ([string]$state.Distro) -ScriptText $listScript -Arguments @([string]$state.InstallDir)
    if ($list.ExitCode -ne 0) { throw 'Could not read the installed deploy scripts. Check that the saved WSL distro and folder still exist.' }
    $available = @($list.Output -split "`r?`n" | ForEach-Object { $_ -replace '\.sh$', '' })
    if ($available -notcontains $normalizedName) {
        throw "Unknown script '$Name'. Available scripts: $($available -join ', '); special command: logs."
    }
    $result = Invoke-Wsl -Arguments (@('-d', [string]$state.Distro, '--cd', [string]$state.InstallDir, '--exec', "./$normalizedName.sh") + $Arguments) -PassThruConsole
    if ($result.ExitCode -ne 0) { throw "$normalizedName.sh exited with code $($result.ExitCode)." }
}

if (-not $WrapperNoRun) {
    try {
        Invoke-GachipadCommand -Name $ScriptName -Arguments $ScriptArgs
    } catch {
        Write-Error $_.Exception.Message
        exit 1
    }
}
