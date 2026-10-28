param(
    [string]$Db,
    [string]$DatabaseUrl,
    [string]$Network,
    [string]$Domain,
    [string]$AcmeEmail,
    [switch]$BehindProxy,
    [string[]]$InstallArgs = @(),
    [string]$Distro,
    [string]$InstallDir = '~/gachipad',
    [switch]$OpenFirewall,
    [switch]$InstallWsl,
    [string]$BundlePath,
    [switch]$NoRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$installerPath = $PSCommandPath
if ([string]::IsNullOrWhiteSpace($installerPath)) { $installerPath = $MyInvocation.MyCommand.Path }
if ([string]::IsNullOrWhiteSpace($installerPath)) { $script:InstallerRoot = $PSScriptRoot }
else { $script:InstallerRoot = Split-Path -Parent $installerPath }
$script:InstallerOptions = @{
    Db = $Db
    DatabaseUrl = $DatabaseUrl
    Network = $Network
    Domain = $Domain
    AcmeEmail = $AcmeEmail
    BehindProxy = $BehindProxy
    InstallArgs = $InstallArgs
    Distro = $Distro
    InstallDir = $InstallDir
    OpenFirewall = $OpenFirewall
    InstallWsl = $InstallWsl
    BundlePath = $BundlePath
}

function Write-InstallError {
    param([Parameter(Mandatory = $true)][string]$Message)
    throw [System.InvalidOperationException]::new($Message)
}

# ProcessStartInfo.Arguments uses Windows CRT quoting, independently of PowerShell's
# Legacy/Standard native argument mode. WSL --exec keeps these values out of a shell.
function ConvertTo-NativeArgument {
    param([AllowEmptyString()][string]$Value)
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function ConvertFrom-WslOutput {
    param([byte[]]$Bytes)
    if ($Bytes.Length -ge 2 -and (($Bytes[0] -eq 255 -and $Bytes[1] -eq 254) -or
        [Array]::IndexOf($Bytes, [byte]0) -ge 0)) {
        return [System.Text.Encoding]::Unicode.GetString($Bytes).Trim([char]0xFEFF).Replace([string][char]0, '')
    }
    return [System.Text.Encoding]::UTF8.GetString($Bytes).Trim([char]0xFEFF)
}

function Invoke-Wsl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string[]]$Arguments,
        [switch]$PassThruConsole,
        [string]$InputText
    )

    $executable = $env:GACHIPAD_WSL_EXE
    if ([string]::IsNullOrWhiteSpace($executable)) {
        $command = Get-Command 'wsl.exe' -ErrorAction SilentlyContinue
        if ($null -ne $command) { $executable = $command.Source }
    }
    if ([string]::IsNullOrWhiteSpace($executable)) {
        return [pscustomobject]@{ ExitCode = 127; Output = 'wsl.exe was not found' }
    }

    $start = New-Object System.Diagnostics.ProcessStartInfo
    if ([System.IO.Path]::GetExtension($executable) -ieq '.ps1') {
        # Test overrides still cross a native process boundary.
        $Arguments = @('-NoLogo', '-NoProfile', '-File', $executable) + $Arguments
        $executable = (Get-Process -Id $PID).Path
    }
    $start.FileName = $executable
    $start.Arguments = ($Arguments | ForEach-Object { ConvertTo-NativeArgument -Value $_ }) -join ' '
    $start.UseShellExecute = $false
    $start.EnvironmentVariables['WSL_UTF8'] = '1'
    $start.RedirectStandardOutput = -not $PassThruConsole
    $start.RedirectStandardError = -not $PassThruConsole
    $start.RedirectStandardInput = $PSBoundParameters.ContainsKey('InputText')
    if ($PassThruConsole -and $start.RedirectStandardInput) { throw 'Console calls cannot redirect stdin.' }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    $stdout = New-Object System.IO.MemoryStream
    $stderr = New-Object System.IO.MemoryStream
    try {
        [void]$process.Start()
        if (-not $PassThruConsole) {
            $readOutput = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
            $readError = $process.StandardError.BaseStream.CopyToAsync($stderr)
        }
        if ($start.RedirectStandardInput) {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($InputText.Replace("`r`n", "`n").Replace("`r", "`n"))
            $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
            $process.StandardInput.Close()
        }
        $process.WaitForExit()
        $output = ''
        if (-not $PassThruConsole) {
            [void]$readOutput.GetAwaiter().GetResult()
            [void]$readError.GetAwaiter().GetResult()
            $output = (ConvertFrom-WslOutput -Bytes $stdout.ToArray()) + (ConvertFrom-WslOutput -Bytes $stderr.ToArray())
            $output = $output.TrimEnd("`r", "`n")
        }
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $output }
    } finally {
        $process.Dispose()
        $stdout.Dispose()
        $stderr.Dispose()
    }
}

function Invoke-WslScript {
    param([string]$SelectedDistro, [string]$ScriptText, [string[]]$Arguments = @())
    return Invoke-Wsl -Arguments (@('-d', $SelectedDistro, '--exec', 'bash', '-s', '--') + $Arguments) -InputText ($ScriptText + "`n")
}

function Get-WindowsHostInfo {
    $currentVersion = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $build = 0
    [void][int]::TryParse([string]$currentVersion.CurrentBuildNumber, [ref]$build)
    return [pscustomobject]@{
        ProductName = [string]$currentVersion.ProductName
        Build = $build
        Is64Bit = [Environment]::Is64BitOperatingSystem
    }
}

function Get-VirtualizationStatus {
    try {
        $computer = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
        if ($computer.HypervisorPresent) { return 'available' }
        return 'not detected; check that CPU virtualization is enabled in UEFI and Windows features'
    } catch {
        return 'could not be detected; continuing because Windows virtualization detection is uncertain'
    }
}

function Test-IsElevated {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Get-DockerDesktopStatus {
    $paths = @(@($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_)
    } | ForEach-Object { Join-Path $_ 'Docker\Docker\Docker Desktop.exe' })
    $installed = $false
    foreach ($path in $paths) {
        if (-not [string]::IsNullOrWhiteSpace($path) -and (Test-Path -LiteralPath $path)) {
            $installed = $true
        }
    }
    if (Test-Path 'HKLM:\SOFTWARE\Docker Inc.\Docker') { $installed = $true }
    $running = $false
    try {
        $running = $null -ne (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue | Select-Object -First 1)
    } catch {
        $running = $false
    }
    return [pscustomobject]@{ Installed = $installed; Running = $running }
}

function Get-FirewallRule {
    param([string]$Name)
    return Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue
}

function Remove-FirewallRule {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([object]$Rule)
    if ($PSCmdlet.ShouldProcess($Rule.DisplayName, 'Remove existing firewall rule')) {
        Remove-NetFirewallRule -InputObject $Rule -ErrorAction Stop
    }
}

function New-FirewallRule {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [string]$Name,
        [string]$Port,
        [string[]]$Profiles
    )
    if ($PSCmdlet.ShouldProcess($Name, "Create inbound TCP firewall rule for port $Port")) {
        New-NetFirewallRule -DisplayName $Name -Direction Inbound -Action Allow -Protocol TCP `
            -LocalPort $Port -Profile $Profiles -ErrorAction Stop | Out-Null
    }
}

function Get-HostIPv4 {
    $virtualName = '(?i)(vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker|Loopback|Default Switch)'
    $upAdapters = @(Get-NetAdapter -ErrorAction Stop | Where-Object {
            $_.Status -eq 'Up' -and $_.Name -notmatch $virtualName -and $_.InterfaceDescription -notmatch $virtualName
        } | ForEach-Object { [int]$_.ifIndex })
    return @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object {
            $upAdapters -contains [int]$_.InterfaceIndex -and
            $_.IPAddress -notlike '169.254.*' -and
            $_.IPAddress -ne '127.0.0.1'
        } | Select-Object -ExpandProperty IPAddress -Unique)
}

function Get-WslDistributionList {
    param([string]$Output, [string[]]$Names)
    $found = @{}
    $orderedNames = @($Names | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Sort-Object Length -Descending)
    foreach ($line in ($Output -split "`r?`n")) {
        foreach ($name in $orderedNames) {
            $pattern = '^\s*(?<default>\*)?\s*' + [regex]::Escape($name) + '\s+.+?\s+(?<version>[12])\s*$'
            $match = [regex]::Match($line, $pattern)
            if ($match.Success) {
                $found[$name] = [pscustomobject]@{
                    Name = $name
                    Version = [int]$match.Groups['version'].Value
                    IsDefault = $match.Groups['default'].Success
                }
                break
            }
        }
    }
    $distros = @($Names | ForEach-Object { if ($found.ContainsKey($_.Trim())) { $found[$_.Trim()] } })
    return ,$distros
}

function Get-InstallStatePath {
    $base = $env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($base)) {
        $base = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    }
    if ([string]::IsNullOrWhiteSpace($base)) { $base = $env:TEMP }
    return Join-Path (Join-Path $base 'gachipad') 'install.json'
}

function Get-BundleSource {
    if (-not [string]::IsNullOrWhiteSpace($script:InstallerOptions.BundlePath)) {
        $resolved = (Resolve-Path -LiteralPath $script:InstallerOptions.BundlePath -ErrorAction Stop).Path
        if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
            Write-InstallError '-BundlePath must name a .tar.gz bundle file.'
        }
        return [pscustomobject]@{ Path = $resolved; Kind = 'archive' }
    }
    $source = (Resolve-Path -LiteralPath $script:InstallerRoot -ErrorAction Stop).Path
    $repository = Split-Path -Parent $source
    if (-not (Test-Path -LiteralPath (Join-Path $source 'images.tar')) -and
        (Test-Path -LiteralPath (Join-Path $repository 'package.json')) -and
        (Test-Path -LiteralPath (Join-Path $source 'docker-compose.yml')) -and
        (Test-Path -LiteralPath (Join-Path $source 'bundle.sh'))) {
        return [pscustomobject]@{ Path = $repository; Kind = 'repository' }
    }
    return [pscustomobject]@{ Path = $source; Kind = 'directory' }
}

function Test-BundleChecksum {
    param([string]$Path)
    $sidecar = "$Path.sha256"
    if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf)) { return }
    $line = Get-Content -LiteralPath $sidecar -TotalCount 1
    $match = [regex]::Match([string]$line, '^\s*(?<hash>[0-9a-fA-F]{64})(?:\s+\*?.+)?\s*$')
    if (-not $match.Success) { Write-InstallError "Invalid SHA-256 file: $sidecar" }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    if ($actual -ine $match.Groups['hash'].Value) {
        Write-InstallError "Bundle checksum mismatch: $Path. Download the bundle and its matching .sha256 file again."
    }
    Write-Output 'Bundle SHA-256 verified.'
}

function Test-ShellFileLineEnding {
    param([string]$Directory)
    foreach ($file in (Get-ChildItem -LiteralPath $Directory -Filter '*.sh' -File -Recurse)) {
        $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
        if ([Array]::IndexOf($bytes, [byte]13) -ge 0) {
            Write-InstallError "Refusing shell script with CR line endings: $($file.FullName). Set git core.autocrlf=false or use the repository .gitattributes, then check out the files again."
        }
    }
}

function Get-WslPath {
    param(
        [string]$SelectedDistro,
        [string]$WindowsPath
    )
    $result = Invoke-Wsl -Arguments @('-d', $SelectedDistro, '--exec', 'wslpath', '-u', $WindowsPath)
    if ($result.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($result.Output)) {
        Write-InstallError "Could not convert the source path into WSL. Check that the Windows drive is mounted in distro '$SelectedDistro'."
    }
    return $result.Output.Trim()
}

function Copy-InstallSourceToWsl {
    param(
        [string]$SelectedDistro,
        [string]$SourcePath,
        [string]$SourceKind,
        [string]$Destination
    )
    $sourceUnix = Get-WslPath -SelectedDistro $SelectedDistro -WindowsPath $SourcePath
    $copyScript = @'
set -eu
DEST="$1"
case "$DEST" in
  '~') DEST="$HOME" ;;
  '~/'*) DEST="$HOME/${DEST#\~/}" ;;
  /*) ;;
  *) DEST="$HOME/$DEST" ;;
esac
DEST="$(realpath -m -- "$DEST")"
PARENT="$DEST"
while [ ! -e "$PARENT" ]; do PARENT="$(dirname "$PARENT")"; done
FSTYPE="$(stat -f -c %T -- "$PARENT")"
case "$DEST:$FSTYPE" in /mnt:*|/mnt/*:*|*:9p|*:drvfs|*:v9fs)
  echo "InstallDir resolves to a Windows filesystem; choose a Linux path such as ~/gachipad." >&2
  exit 42 ;;
esac
mkdir -p -- "$DEST"
DEST="$(realpath -e -- "$DEST")"
STAGE="$(mktemp -d "${DEST}.stage.XXXXXX")"
BUILD_SOURCE=""
cleanup() { rm -rf "$STAGE"; [ -z "$BUILD_SOURCE" ] || rm -rf "$BUILD_SOURCE"; }
trap cleanup EXIT HUP INT TERM
KIND="$2"
SOURCE="$3"
if [ "$KIND" = archive ]; then
  tar -xzf "$SOURCE" -C "$STAGE" --strip-components=1
elif [ "$KIND" = repository ]; then
  BUILD_SOURCE="$(mktemp -d "${DEST}.source.XXXXXX")"
  (cd "$SOURCE" && tar --exclude=.git --exclude='*/.git' --exclude=node_modules --exclude='*/node_modules' \
    --exclude=.turbo --exclude='*/.turbo' --exclude=dist --exclude='*/dist' \
    --exclude=.box-out --exclude='*/.box-out' --exclude=.env --exclude='*/.env' \
    --exclude=backups --exclude='*/backups' --exclude=state --exclude='*/state' -cf - .) |
    tar -xf - -C "$BUILD_SOURCE"
  if [ ! -f "$BUILD_SOURCE/deploy/bundle.sh" ]; then
    echo 'Repository source does not contain deploy/bundle.sh; run this installer from the repository deploy folder.' >&2
    exit 43
  fi
  (cd "$BUILD_SOURCE/deploy" && ./bundle.sh)
  BUNDLE="$(find "$BUILD_SOURCE/deploy/dist" -maxdepth 1 -type f -name 'gachipad-*.tar.gz' ! -name 'gachipad-deploy-*' -print -quit)"
  if [ -z "$BUNDLE" ]; then
    echo 'deploy/bundle.sh completed without creating an offline gachipad bundle.' >&2
    exit 43
  fi
  tar -xzf "$BUNDLE" -C "$STAGE" --strip-components=1
else
  cp -a "$SOURCE"/. "$STAGE"/
fi
if [ ! -f "$STAGE/install.sh" ]; then
  echo 'The source does not contain install.sh. Select an offline gachipad bundle or the repository deploy folder.' >&2
  exit 43
fi
if [ ! -f "$STAGE/images.tar" ]; then
  echo 'images.tar is missing. Use the full offline gachipad bundle, including images.tar, rather than the update-only bundle.' >&2
  exit 44
fi
for ITEM in "$STAGE"/* "$STAGE"/.[!.]* "$STAGE"/..?*; do
  [ -e "$ITEM" ] || continue
  NAME="${ITEM##*/}"
  [ "$NAME" = .env ] && continue
  cp -a "$ITEM" "$DEST"/
done
chmod +x "$DEST"/*.sh
BAD=""
for FILE in "$DEST"/*.sh; do
  [ -f "$FILE" ] || continue
  if LC_ALL=C grep -q "$(printf '\r')" "$FILE"; then BAD="$BAD$FILE\n"; fi
done
if [ -n "$BAD" ]; then
  printf '%b' "$BAD" >&2
  exit 45
fi
printf '%s\n' "$DEST"
'@
    $result = Invoke-WslScript -SelectedDistro $SelectedDistro -ScriptText $copyScript -Arguments @($Destination, $SourceKind, $sourceUnix)
    if ($result.ExitCode -eq 42) {
        Write-InstallError "InstallDir must be inside the WSL Linux filesystem, not /mnt/c or another drvfs path. Choose ~/gachipad or another path under the Linux home directory."
    }
    if ($result.ExitCode -eq 44) { Write-InstallError $result.Output }
    if ($result.ExitCode -eq 45) {
        Write-InstallError "A copied .sh file has CR line endings. Set git core.autocrlf=false or use the repository .gitattributes, then check out the files again."
    }
    if ($result.ExitCode -ne 0) {
        if (-not [string]::IsNullOrWhiteSpace($result.Output)) { Write-Output $result.Output }
        Write-InstallError 'Could not copy the installation into the WSL Linux filesystem. Check the source and available disk space, then retry.'
    }
    $installedPath = ($result.Output -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Last 1).Trim()
    if ([string]::IsNullOrWhiteSpace($installedPath)) { $installedPath = $Destination }
    return $installedPath
}

function Get-InstallConfig {
    param(
        [string]$SelectedDistro,
        [string]$Directory
    )
    $scriptText = @'
set -eu
cd "$1"
. ./lib.sh
env_get PUBLIC_URL; printf '\n'
env_get HTTP_PORT 80; printf '\n'
env_get HTTPS_PORT 443; printf '\n'
env_get GACHIPAD_NETWORK internal; printf '\n'
'@
    $result = Invoke-WslScript -SelectedDistro $SelectedDistro -ScriptText $scriptText -Arguments @($Directory)
    if ($result.ExitCode -ne 0) { Write-InstallError 'The installation completed, but .env settings could not be read.' }
    $values = @($result.Output -split "`r?`n")
    while ($values.Count -lt 4) { $values += '' }
    return [pscustomobject]@{
        PublicUrl = $values[0].Trim()
        HttpPort = $values[1].Trim()
        HttpsPort = $values[2].Trim()
        Network = $values[3].Trim()
    }
}

function Get-ExistingDatabaseUrl {
    param(
        [string]$SelectedDistro,
        [string]$Directory
    )
    $scriptText = @'
set -eu
cd "$1"
. ./lib.sh
env_get DATABASE_URL
'@
    $result = Invoke-WslScript -SelectedDistro $SelectedDistro -ScriptText $scriptText -Arguments @($Directory)
    if ($result.ExitCode -ne 0) { Write-InstallError 'Could not read the existing database setting from .env.' }
    return $result.Output.Trim()
}

function Get-NetworkingMode {
    param([string]$SelectedDistro)
    $result = Invoke-WslScript -SelectedDistro $SelectedDistro -ScriptText 'if command -v wslinfo >/dev/null 2>&1; then wslinfo --networking-mode 2>/dev/null || true; fi'
    $mode = $result.Output.Trim().ToLowerInvariant()
    if ($mode -eq 'mirrored') { return 'mirrored' }
    if ($mode -eq 'nat') { return 'nat' }
    $configPath = ''
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        $configPath = Join-Path $env:USERPROFILE '.wslconfig'
    }
    if (-not [string]::IsNullOrWhiteSpace($configPath) -and (Test-Path -LiteralPath $configPath)) {
        $section = ''
        foreach ($line in (Get-Content -LiteralPath $configPath)) {
            if ($line -match '^\s*\[(?<name>[^]]+)\]\s*$') {
                $section = $Matches.name.ToLowerInvariant()
            } elseif ($section -eq 'wsl2' -and $line -match '^\s*networkingMode\s*=\s*mirrored\s*$') {
                return 'mirrored'
            }
        }
    }
    return 'nat'
}

function Invoke-FirewallSetup {
    param(
        [string]$HttpPort,
        [string]$HttpsPort,
        [string]$NetworkMode
    )
    if (-not (Test-IsElevated)) {
        Write-Output 'Firewall rules were not changed because this PowerShell session is not elevated. Rerun PowerShell as Administrator and use -OpenFirewall.'
        return
    }
    $profiles = @('Domain', 'Private')
    if ($NetworkMode -eq 'public') { $profiles += 'Public' }
    foreach ($entry in @(@('gachipad HTTP', $HttpPort), @('gachipad HTTPS', $HttpsPort))) {
        $existing = Get-FirewallRule -Name $entry[0]
        if ($null -ne $existing) { Remove-FirewallRule -Rule $existing }
        New-FirewallRule -Name $entry[0] -Port $entry[1] -Profiles $profiles
    }
    Write-Output "Created inbound TCP firewall rules for ports $HttpPort and $HttpsPort ($($profiles -join ', '))."
}

function Write-FirewallCommand {
    param(
        [string]$HttpPort,
        [string]$HttpsPort,
        [string]$NetworkMode
    )
    $profiles = 'Domain,Private'
    if ($NetworkMode -eq 'public') { $profiles = 'Domain,Private,Public' }
    Write-Output 'To open inbound TCP ports, run PowerShell as Administrator and execute:'
    Write-Output "New-NetFirewallRule -DisplayName 'gachipad HTTP' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $HttpPort -Profile $profiles"
    Write-Output "New-NetFirewallRule -DisplayName 'gachipad HTTPS' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $HttpsPort -Profile $profiles"
}

function Get-ForwardedInstallArgument {
    $options = $script:InstallerOptions
    $arguments = @()
    if (-not [string]::IsNullOrWhiteSpace($options.Db)) { $arguments += @('--db', $options.Db) }
    if (-not [string]::IsNullOrWhiteSpace($options.DatabaseUrl)) { $arguments += @('--database-url', $options.DatabaseUrl) }
    if (-not [string]::IsNullOrWhiteSpace($options.Network)) { $arguments += @('--network', $options.Network) }
    if (-not [string]::IsNullOrWhiteSpace($options.Domain)) { $arguments += @('--domain', $options.Domain) }
    if (-not [string]::IsNullOrWhiteSpace($options.AcmeEmail)) { $arguments += @('--acme-email', $options.AcmeEmail) }
    if ($options.BehindProxy) { $arguments += '--behind-proxy' }
    if ($options.InstallArgs.Count -gt 0) { $arguments += $options.InstallArgs }
    if (-not ($arguments -contains '--mdns')) { $arguments += '--no-mdns' }
    return ,$arguments
}

function Get-DatabaseUrlIfNeeded {
    param([string]$ExistingDatabaseUrl)
    $options = $script:InstallerOptions
    $databaseUrl = $options.DatabaseUrl
    $externalDatabase = $options.Db -eq 'external'
    $databaseUrlArgumentProvided = $options.InstallArgs -contains '--database-url'
    for ($index = 0; $index -lt $options.InstallArgs.Count; $index++) {
        if ($options.InstallArgs[$index] -eq '--db' -and $index + 1 -lt $options.InstallArgs.Count -and $options.InstallArgs[$index + 1] -eq 'external') {
            $externalDatabase = $true
        }
    }
    if ($externalDatabase -and -not $databaseUrlArgumentProvided -and
        [string]::IsNullOrWhiteSpace($databaseUrl) -and [string]::IsNullOrWhiteSpace($ExistingDatabaseUrl)) {
        $secureValue = Read-Host 'DATABASE_URL (input hidden)' -AsSecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
        try {
            $databaseUrl = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    }
    return $databaseUrl
}

function Write-InstallState {
    param(
        [string]$SelectedDistro,
        [string]$Directory
    )
    $path = Get-InstallStatePath
    $parent = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    $json = [pscustomobject]@{ Version = 1; Distro = $SelectedDistro; InstallDir = $Directory } | ConvertTo-Json
    $temporary = Join-Path $parent ([guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [System.IO.File]::WriteAllText($temporary, $json, (New-Object System.Text.UTF8Encoding($false)))
        if ([System.IO.File]::Exists($path)) { [System.IO.File]::Replace($temporary, $path, [NullString]::Value) }
        else { [System.IO.File]::Move($temporary, $path) }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Invoke-Installer {
    $options = $script:InstallerOptions
    $hostInfo = Get-WindowsHostInfo
    if (-not $hostInfo.Is64Bit) { Write-InstallError 'A 64-bit version of Windows is required. Upgrade to 64-bit Windows 10 22H2 or Windows 11.' }
    $isWindows11 = $hostInfo.Build -ge 22000
    $isWindows10Supported = $hostInfo.Build -eq 19045 -and $hostInfo.ProductName -match 'Windows 10'
    if (-not ($isWindows11 -or $isWindows10Supported)) {
        Write-InstallError 'Supported hosts are 64-bit Windows 10 22H2 (build 19045) or Windows 11. Install a supported Windows version and rerun.'
    }
    Write-Output "Windows host: $($hostInfo.ProductName), build $($hostInfo.Build), 64-bit."
    Write-Output "Virtualization: $(Get-VirtualizationStatus)."

    $status = Invoke-Wsl -Arguments @('--status')
    if ($status.ExitCode -ne 0) {
        if ($options.InstallWsl -and (Test-IsElevated)) {
            $installResult = Invoke-Wsl -Arguments @('--install', '-d', 'Ubuntu') -PassThruConsole
            if ($installResult.ExitCode -ne 0) { Write-InstallError 'WSL installation failed. Enable Virtual Machine Platform and WSL in Windows Features, reboot, then run wsl --install -d Ubuntu again.' }
            Write-InstallError 'WSL installation was started. Reboot Windows, then rerun this installer.'
        }
        if ($options.InstallWsl) { Write-InstallError 'WSL installation needs an elevated PowerShell session. Run PowerShell as Administrator and use -InstallWsl.' }
        Write-InstallError 'WSL 2 is not available. Run PowerShell as Administrator and execute: wsl --install -d Ubuntu. Reboot, then rerun this installer.'
    }
    $list = Invoke-Wsl -Arguments @('-l', '-v')
    if ($list.ExitCode -ne 0) { Write-InstallError 'Could not list WSL distributions. Run wsl --update, then wsl --list --verbose and retry.' }
    $quiet = Invoke-Wsl -Arguments @('-l', '-q')
    if ($quiet.ExitCode -ne 0) { Write-InstallError 'Could not list WSL distribution names. Run wsl --update and retry.' }
    $names = @($quiet.Output -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $distros = Get-WslDistributionList -Output $list.Output -Names $names
    if ($names.Count -gt 0 -and $distros.Count -ne $names.Count) { Write-InstallError 'Could not read WSL distribution versions. Run wsl --update, then wsl --list --verbose and retry.' }
    if ($distros.Count -eq 0) {
        if ($options.InstallWsl -and (Test-IsElevated)) {
            $installResult = Invoke-Wsl -Arguments @('--install', '-d', 'Ubuntu') -PassThruConsole
            if ($installResult.ExitCode -ne 0) { Write-InstallError 'WSL installation failed. Run wsl --install -d Ubuntu from an elevated PowerShell session, then reboot.' }
            Write-InstallError 'Ubuntu installation was started. Reboot Windows, finish the Ubuntu first-run setup, then rerun this installer.'
        }
        if ($options.InstallWsl) { Write-InstallError 'No WSL distribution is installed. Run PowerShell as Administrator and use -InstallWsl, then reboot and rerun.' }
        Write-InstallError 'No WSL distribution is installed. Run wsl --install -d Ubuntu, finish first-run setup, then rerun this installer.'
    }

    $selectedDistro = $options.Distro
    if ([string]::IsNullOrWhiteSpace($selectedDistro)) {
        $defaultEntry = $distros | Where-Object { $_.IsDefault } | Select-Object -First 1
        if ($null -ne $defaultEntry) { $selectedDistro = $defaultEntry.Name }
        if ([string]::IsNullOrWhiteSpace($selectedDistro)) { $selectedDistro = $distros[0].Name }
    }
    $selectedEntry = $distros | Where-Object { $_.Name -eq $selectedDistro } | Select-Object -First 1
    if ($null -eq $selectedEntry) {
        $available = ($distros | ForEach-Object { $_.Name }) -join ', '
        Write-InstallError "WSL distro '$selectedDistro' was not found. Choose one of: $available; or install one with wsl --install -d Ubuntu."
    }
    if ($selectedEntry.Version -ne 2) {
        Write-InstallError "WSL distro '$selectedDistro' is version 1. Convert it with: wsl --set-version '$selectedDistro' 2, then rerun this installer."
    }
    Write-Output "Using WSL 2 distribution '$selectedDistro'."

    $dockerInfo = Invoke-Wsl -Arguments @('-d', $selectedDistro, '--exec', 'docker', 'info')
    if ($dockerInfo.ExitCode -ne 0) {
        $desktop = Get-DockerDesktopStatus
        if ($dockerInfo.Output -match '(?i)permission denied.*docker\.sock|docker\.sock.*permission denied') {
            Write-InstallError "Docker socket permission was denied in '$selectedDistro'. Add the WSL user to the docker group with sudo usermod -aG docker `$USER, then run wsl --shutdown and reopen the distro."
        }
        if ($desktop.Installed -and -not $desktop.Running) {
            Write-InstallError 'Docker Desktop is installed but is not running. Start Docker Desktop, wait for its engine to be ready, and enable WSL integration for the selected distro if needed.'
        }
        if ($desktop.Installed -and $desktop.Running -and $dockerInfo.Output -match '(?i)not found|command not found|executable file not found') {
            Write-InstallError "Docker Desktop is running, but WSL integration is off for '$selectedDistro'. In Docker Desktop open Settings > Resources > WSL Integration, enable this distro, then Apply & Restart."
        }
        $diagnostic = Invoke-WslScript -SelectedDistro $selectedDistro -ScriptText 'if command -v docker >/dev/null 2>&1; then echo docker-command; fi; if command -v dockerd >/dev/null 2>&1; then echo docker-engine; fi; if [ -d /run/systemd/system ]; then echo systemd; else echo no-systemd; fi'
        if ($diagnostic.Output -match 'docker-engine' -and $diagnostic.Output -match 'no-systemd') {
            Write-InstallError "Docker Engine is installed inside '$selectedDistro' without systemd. Add [boot]`nsystemd=true`n to /etc/wsl.conf, then run wsl --shutdown and reopen the distro."
        }
        if ($desktop.Installed -and $desktop.Running) {
            Write-InstallError "Docker Desktop is running, but its engine is not reachable from '$selectedDistro'. In Docker Desktop open Settings > Resources > WSL Integration, enable this distro, then Apply & Restart."
        }
        if ($dockerInfo.Output -match '(?i)cannot connect|is the docker daemon running') {
            Write-InstallError "Docker is installed but its engine is not reachable in '$selectedDistro'. Start Docker Desktop or start the Docker Engine service inside WSL, then retry."
        }
        Write-InstallError "Docker is not available inside '$selectedDistro'. Install Docker Desktop and enable WSL integration for this distro, or install Docker Engine inside WSL."
    }

    $compose = Invoke-Wsl -Arguments @('-d', $selectedDistro, '--exec', 'docker', 'compose', 'version')
    if ($compose.ExitCode -ne 0) {
        Write-InstallError "Docker works in '$selectedDistro', but Docker Compose is missing. Install the Docker Compose plugin for this engine and retry."
    }
    $dockerOs = Invoke-Wsl -Arguments @('-d', $selectedDistro, '--exec', 'docker', 'info', '--format', '{{.OperatingSystem}}')
    $script:DockerOperatingSystem = $dockerOs.Output.Trim()
    Write-Output "Docker and Docker Compose are reachable in '$selectedDistro'."

    $source = Get-BundleSource
    if ($source.Kind -eq 'archive') { Test-BundleChecksum -Path $source.Path | Out-Null }
    elseif ($source.Kind -eq 'repository') { Test-ShellFileLineEnding -Directory (Join-Path $source.Path 'deploy') }
    else { Test-ShellFileLineEnding -Directory $source.Path }
    $installedPath = Copy-InstallSourceToWsl -SelectedDistro $selectedDistro `
        -SourcePath $source.Path -SourceKind $source.Kind -Destination $options.InstallDir
    Write-Output "Copied installation to WSL Linux filesystem: $installedPath"

    $existingDatabaseUrl = Get-ExistingDatabaseUrl -SelectedDistro $selectedDistro -Directory $installedPath
    $databaseUrlValue = Get-DatabaseUrlIfNeeded -ExistingDatabaseUrl $existingDatabaseUrl
    $arguments = Get-ForwardedInstallArgument
    if (-not [string]::IsNullOrWhiteSpace($databaseUrlValue) -and -not ($arguments -contains '--database-url')) {
        $arguments += @('--database-url', $databaseUrlValue)
    }

    Write-Output 'Starting the Linux installer. Answer its prompts in this terminal.'
    $installResult = Invoke-Wsl -Arguments (@('-d', $selectedDistro, '--cd', $installedPath, '--exec', './install.sh') + $arguments) -PassThruConsole
    if ($installResult.ExitCode -ne 0) { Write-InstallError "The Linux installer exited with code $($installResult.ExitCode). Review its message above, fix the issue, and rerun this command." }

    $settings = Get-InstallConfig -SelectedDistro $selectedDistro -Directory $installedPath
    if ($options.OpenFirewall) {
        Invoke-FirewallSetup -HttpPort $settings.HttpPort -HttpsPort $settings.HttpsPort -NetworkMode $settings.Network
    } else {
        Write-FirewallCommand -HttpPort $settings.HttpPort -HttpsPort $settings.HttpsPort -NetworkMode $settings.Network
    }

    if ($script:DockerOperatingSystem -match '(?i)desktop') {
        Write-Output 'Docker Desktop publishes container ports on the Windows host.'
    } else {
        $networkingMode = Get-NetworkingMode -SelectedDistro $selectedDistro
        if ($networkingMode -eq 'mirrored') {
            Write-Output 'WSL networking mode is mirrored; published ports can be reached through Windows on supported Windows 11 builds.'
        } else {
            Write-Output 'WSL networking mode is NAT. Other machines cannot reach ports published by Docker Engine inside WSL by default.'
            Write-Output 'Fix 1 (Windows 11 22H2+): add networkingMode=mirrored under [wsl2] in %UserProfile%\.wslconfig, then run wsl --shutdown.'
            Write-Output "Fix 2: add a Windows portproxy rule, for example: netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$($settings.HttpPort) connectaddress=<WSL_IP> connectport=$($settings.HttpPort)"
            if ($settings.HttpsPort -ne $settings.HttpPort) {
                Write-Output "For HTTPS, add: netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$($settings.HttpsPort) connectaddress=<WSL_IP> connectport=$($settings.HttpsPort)"
            }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($settings.PublicUrl)) {
        Write-Output "Gachipad URL: $($settings.PublicUrl)"
    } else {
        $addresses = @(Get-HostIPv4)
        if ($addresses.Count -eq 0) {
            Write-Output 'No IPv4 address was found on an up, non-virtual Windows adapter. Check the network adapter state and .env HTTP_PORT.'
        } else {
            foreach ($address in $addresses) { Write-Output "Gachipad URL: http://${address}:$($settings.HttpPort)" }
        }
    }
    Write-Output 'Other commands: .\gachipad.ps1 update --check; .\gachipad.ps1 backup; .\gachipad.ps1 logs.'
    Write-Output 'mDNS is not available from WSL; --no-mdns was passed unless --mdns was explicitly forwarded.'
    Write-InstallState -SelectedDistro $selectedDistro -Directory $installedPath
    Write-Output "Saved WSL location in $(Get-InstallStatePath)."
}

if (-not $NoRun) {
    try {
        Invoke-Installer
    } catch {
        Write-Error $_.Exception.Message
        exit 1
    }
}
