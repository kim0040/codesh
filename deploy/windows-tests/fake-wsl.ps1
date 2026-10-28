Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$inputText = ''
if ($args -contains '-s') { $inputText = [Console]::In.ReadToEnd() }
$mode = $env:GACHIPAD_WSL_FAKE_MODE
if ($mode -eq 'record') {
    $commandLineArgs = [Environment]::GetCommandLineArgs()
    $scriptPath = [System.IO.Path]::GetFullPath($PSCommandPath)
    $scriptIndex = -1
    for ($index = 0; $index -lt $commandLineArgs.Count; $index++) {
        if ([string]::Equals([System.IO.Path]::GetFullPath($commandLineArgs[$index]), $scriptPath, [StringComparison]::OrdinalIgnoreCase)) {
            $scriptIndex = $index
            break
        }
    }
    if ($scriptIndex -lt 0) { throw 'Could not locate the fake WSL script in the child command line.' }
    $nativeArguments = @()
    for ($index = $scriptIndex + 1; $index -lt $commandLineArgs.Count; $index++) { $nativeArguments += $commandLineArgs[$index] }
    $record = [pscustomobject]@{ Arguments = $nativeArguments; InputText = $inputText } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($env:GACHIPAD_WSL_ARGV_LOG, $record + "`n")
    Write-Output 'native-output'
    exit 23
}
if (-not [string]::IsNullOrWhiteSpace($env:GACHIPAD_WSL_ARGV_LOG)) {
    $record = [pscustomobject]@{ Arguments = @($args); InputText = $inputText } | ConvertTo-Json -Compress
    [System.IO.File]::AppendAllText($env:GACHIPAD_WSL_ARGV_LOG, $record + "`n")
}
$joined = (($args | ForEach-Object { [string]$_ }) -join ' ') + $inputText
if (-not [string]::IsNullOrWhiteSpace($env:GACHIPAD_WSL_LOG)) {
    [System.IO.File]::AppendAllText($env:GACHIPAD_WSL_LOG, $joined + [Environment]::NewLine)
}
if ($args -contains '-l' -and $args -contains '-q') {
    if ($mode -eq 'docker-only') {
        Write-Output 'Docker-Desktop'
        Write-Output 'docker-desktop-data'
        exit 0
    }
    if ($mode -eq 'no-distros-text-zero') {
        Write-Output 'Windows Subsystem for Linux has no installed distributions.'
        exit 0
    }
    if ($mode -eq 'no-distros-text-error') {
        Write-Output 'Windows Subsystem for Linux has no installed distributions.'
        exit 1
    }
    if ($mode -eq 'localized') { Write-Output 'Ubuntu Work' }
    Write-Output 'Ubuntu'; exit 0
}

if ($args -contains '--status') {
    if ($mode -eq 'no-wsl') { Write-Output 'WSL is not installed'; exit 1 }
    Write-Output 'Default Distribution: Ubuntu'
    exit 0
}
if ($args -contains '-l' -and $args -contains '-v') {
    if ($mode -eq 'verbose-error') {
        Write-Output 'Windows Subsystem for Linux has no installed distributions.'
        exit 1
    }
    if ($mode -eq 'localized') {
        $running = -join ([char[]]@(0xC2E4, 0xD589, 0x20, 0xC911))
        $stopped = -join ([char[]]@(0xC911, 0xC9C0, 0xB428))
        Write-Output 'NAME STATUS VERSION'
        Write-Output "* Ubuntu Work $running 2"
        Write-Output "  Ubuntu $stopped 1"
    } elseif ($mode -eq 'wsl1') {
        Write-Output '  NAME      STATE           VERSION'
        Write-Output '* Ubuntu    Stopped         1'
    } else {
        Write-Output '  NAME      STATE           VERSION'
        Write-Output '* Ubuntu    Running         2'
    }
    exit 0
}
if ($args -contains '--exec' -and $args[-1] -eq 'true') {
    if ($mode -like 'no-distros-*') { Write-Output 'There is no distribution'; exit 1 }
    exit 0
}
if ($joined -match 'wslpath -u') {
    Write-Output '/mnt/c/fake-source'
    exit 0
}
if ($joined -match 'docker info --format') {
    if ($mode -eq 'docker-desktop') { Write-Output 'Docker Desktop' }
    else { Write-Output 'Ubuntu' }
    exit 0
}
if ($joined -match 'docker info') {
    switch ($mode) {
        'no-docker' { Write-Output 'docker: command not found'; exit 127 }
        'desktop-off' { Write-Output 'docker: command not found'; exit 127 }
        'permission' { Write-Output 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock'; exit 1 }
        'engine-no-systemd' { Write-Output 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock'; exit 1 }
        'desktop-stopped' { Write-Output 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock'; exit 1 }
    }
    Write-Output 'Client: Docker Engine'
    exit 0
}
if ($joined -match 'docker compose version') {
    Write-Output 'Docker Compose version v2.30.0'
    exit 0
}
if ($joined -match 'command -v docker' -and $joined -match 'command -v dockerd') {
    if ($mode -eq 'engine-no-systemd') { Write-Output "docker-command`ndocker-engine`nno-systemd" }
    else { Write-Output 'no-systemd' }
    exit 0
}
if ($joined -match 'wslinfo --networking-mode') {
    if ($mode -eq 'mirrored') { Write-Output 'mirrored' }
    elseif ($mode -eq 'nat') { Write-Output 'nat' }
    exit 0
}
if ($joined -match 'grep -q' -and $joined -match 'images\.tar') {
    Write-Output '/home/test/gachipad'
    exit 0
}
if ($joined -match 'env_get PUBLIC_URL') {
    Write-Output ''
    Write-Output '8080'
    Write-Output '8443'
    Write-Output 'internal'
    exit 0
}
if ($joined -match 'find \.' -and $joined -match "-name '\*\.sh'") {
    Write-Output 'backup.sh'
    Write-Output 'update.sh'
    exit 0
}
exit 0
