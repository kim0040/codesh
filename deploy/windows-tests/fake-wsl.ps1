Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$joined = ($args | ForEach-Object { [string]$_ }) -join ' '
if (-not [string]::IsNullOrWhiteSpace($env:GACHIPAD_WSL_LOG)) {
    [System.IO.File]::AppendAllText($env:GACHIPAD_WSL_LOG, $joined + [Environment]::NewLine)
}
$mode = $env:GACHIPAD_WSL_FAKE_MODE

if ($args -contains '--status') {
    if ($mode -eq 'no-wsl') { Write-Output 'WSL is not installed'; $global:LASTEXITCODE = 1; return }
    Write-Output 'Default Distribution: Ubuntu'
    $global:LASTEXITCODE = 0; return
}
if ($args -contains '-l' -and $args -contains '-v') {
    if ($mode -eq 'wsl1') {
        Write-Output '  NAME      STATE           VERSION'
        Write-Output '* Ubuntu    Stopped         1'
    } else {
        Write-Output '  NAME      STATE           VERSION'
        Write-Output '* Ubuntu    Running         2'
    }
    $global:LASTEXITCODE = 0; return
}
if ($joined -match 'wslpath -u') {
    Write-Output '/mnt/c/fake-source'
    $global:LASTEXITCODE = 0; return
}
if ($joined -match 'docker info --format') {
    if ($mode -eq 'docker-desktop') { Write-Output 'Docker Desktop' }
    else { Write-Output 'Ubuntu' }
    $global:LASTEXITCODE = 0; return
}
if ($joined -match 'docker info') {
    switch ($mode) {
        'no-docker' { Write-Output 'docker: command not found'; $global:LASTEXITCODE = 127; return }
        'desktop-off' { Write-Output 'docker: command not found'; $global:LASTEXITCODE = 127; return }
        'permission' { Write-Output 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock'; $global:LASTEXITCODE = 1; return }
        'engine-no-systemd' { Write-Output 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock'; $global:LASTEXITCODE = 1; return }
        'desktop-stopped' { Write-Output 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock'; $global:LASTEXITCODE = 1; return }
    }
    Write-Output 'Client: Docker Engine'
    $global:LASTEXITCODE = 0; return
}
if ($joined -match 'docker compose version') {
    Write-Output 'Docker Compose version v2.30.0'
    $global:LASTEXITCODE = 0; return
}
if ($joined -match 'command -v docker' -and $joined -match 'command -v dockerd') {
    if ($mode -eq 'engine-no-systemd') { Write-Output "docker-command`ndocker-engine`nno-systemd" }
    else { Write-Output 'no-systemd' }
    $global:LASTEXITCODE = 0; return
}
if ($joined -match 'wslinfo --networking-mode') {
    if ($mode -eq 'mirrored') { Write-Output 'mirrored' }
    elseif ($mode -eq 'nat') { Write-Output 'nat' }
    $global:LASTEXITCODE = 0; return
}
if ($joined -match 'grep -q' -and $joined -match 'images\.tar') {
    if ($mode -eq 'crlf') { Write-Output '/home/test/gachipad/install.sh'; $global:LASTEXITCODE = 45; return }
    Write-Output '/home/test/gachipad'
    $global:LASTEXITCODE = 0; return
}
if ($joined -match 'env_get PUBLIC_URL') {
    Write-Output ''
    Write-Output '8080'
    Write-Output '8443'
    Write-Output 'internal'
    $global:LASTEXITCODE = 0; return
}
if ($joined -match 'find \.' -and $joined -match "-name '\*\.sh'") {
    Write-Output 'backup.sh'
    Write-Output 'update.sh'
    $global:LASTEXITCODE = 0; return
}
$global:LASTEXITCODE = 0; return
