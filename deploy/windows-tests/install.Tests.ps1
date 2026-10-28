BeforeAll {
    $script:installPath = Join-Path $PSScriptRoot '..\install.ps1'
    $script:gachipadPath = Join-Path $PSScriptRoot '..\gachipad.ps1'
    . $script:installPath -NoRun
    . $script:gachipadPath -WrapperNoRun
    $script:InstallerRoot = Split-Path -Parent (Resolve-Path -LiteralPath $script:installPath).Path
    $script:testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('gachipad-tests-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $script:testRoot -Force | Out-Null
    $env:LOCALAPPDATA = $script:testRoot
    $script:fakeLog = Join-Path $script:testRoot 'wsl.log'
    $env:GACHIPAD_WSL_LOG = $script:fakeLog
    $script:argvLog = Join-Path $script:testRoot 'argv.jsonl'
    $env:GACHIPAD_WSL_ARGV_LOG = $script:argvLog
    $env:GACHIPAD_WSL_EXE = Join-Path $PSScriptRoot 'fake-wsl.ps1'
}

AfterAll {
    Remove-Item -LiteralPath $script:testRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item Env:GACHIPAD_WSL_EXE -ErrorAction SilentlyContinue
    Remove-Item Env:GACHIPAD_WSL_LOG -ErrorAction SilentlyContinue
    Remove-Item Env:GACHIPAD_WSL_ARGV_LOG -ErrorAction SilentlyContinue
    Remove-Item Env:GACHIPAD_WSL_FAKE_MODE -ErrorAction SilentlyContinue
}

Describe 'Windows WSL installer' {
    BeforeEach {
        $script:InstallerOptions.Db = ''
        $script:InstallerOptions.DatabaseUrl = ''
        $script:InstallerOptions.Network = ''
        $script:InstallerOptions.Domain = ''
        $script:InstallerOptions.AcmeEmail = ''
        $script:InstallerOptions.BehindProxy = ''
        $script:InstallerOptions.InstallArgs = @()
        $script:InstallerOptions.Distro = ''
        $script:InstallerOptions.InstallDir = '~/gachipad'
        $script:InstallerOptions.OpenFirewall = $false
        $script:InstallerOptions.InstallWsl = $false
        $script:InstallerOptions.BundlePath = ''
        $env:GACHIPAD_WSL_FAKE_MODE = 'success'
        [System.IO.File]::WriteAllText($script:fakeLog, '')
        [System.IO.File]::WriteAllText($script:argvLog, '')
        Mock Get-WindowsHostInfo {
            [pscustomobject]@{ ProductName = 'Windows 11 Pro'; Build = 22631; Is64Bit = $true }
        }
        Mock Get-WslRegistryDistributionList { [pscustomobject]@{ Available = $false; Entries = @() } }
        Mock Get-VirtualizationStatus { 'available' }
        Mock Get-DockerDesktopStatus { [pscustomobject]@{ Installed = $false; Running = $false } }
        Mock Test-IsElevated { $false }
        Mock Get-HostIPv4 { @('192.0.2.20') }
    }

    It 'explains how to install WSL when WSL is unavailable' {
        $env:GACHIPAD_WSL_FAKE_MODE = 'no-wsl'
        { Invoke-Installer } | Should -Throw '*wsl --install -d Ubuntu*'
    }

    It 'ignores only the Docker Desktop helper distros case-insensitively' {
        $names = @(Get-InstallableWslDistributionList -Names @('Docker-Desktop', 'docker-desktop-data', 'docker-desktop-test', 'Ubuntu'))
        $names.Count | Should -Be 2
        $names[0] | Should -BeExactly 'docker-desktop-test'
        $names[1] | Should -BeExactly 'Ubuntu'
    }

    It 'uses the no-distro guidance when Docker Desktop helpers are the only registry entries' {
        Mock Get-WslRegistryDistributionList {
            [pscustomobject]@{
                Available = $true
                Entries = @(
                    [pscustomobject]@{ Name = 'Docker-Desktop'; Version = 2; IsDefault = $true }
                    [pscustomobject]@{ Name = 'docker-desktop-data'; Version = 2; IsDefault = $false }
                )
            }
        }
        { Invoke-Installer } | Should -Throw '*No WSL distribution is installed.*wsl --install -d Ubuntu*'
        @(Get-Content -LiteralPath $script:argvLog -Encoding UTF8).Count | Should -Be 1
    }

    It 'uses the no-distro guidance when Docker Desktop helpers are the only quiet-list entries' {
        $env:GACHIPAD_WSL_FAKE_MODE = 'docker-only'
        { Invoke-Installer } | Should -Throw '*No WSL distribution is installed.*wsl --install -d Ubuntu*'
    }

    It 'does not select a Docker Desktop default distro when a user distro is available' {
        Mock Get-WslRegistryDistributionList {
            [pscustomobject]@{
                Available = $true
                Entries = @(
                    [pscustomobject]@{ Name = 'docker-desktop'; Version = 2; IsDefault = $true }
                    [pscustomobject]@{ Name = 'Ubuntu'; Version = 2; IsDefault = $false }
                )
            }
        }
        $output = Invoke-Installer 6>&1 | Out-String
        $output | Should -Match "Using WSL 2 distribution 'Ubuntu'"
    }

    It 'uses no-distro guidance for noisy empty name output with either WSL exit code' {
        foreach ($mode in @('no-distros-text-zero', 'no-distros-text-error')) {
            $env:GACHIPAD_WSL_FAKE_MODE = $mode
            { Invoke-Installer } | Should -Throw '*No WSL distribution is installed.*wsl --install -d Ubuntu*'
        }
    }

    It 'uses registry distro versions when the verbose WSL listing fails' {
        Mock Get-WslRegistryDistributionList {
            [pscustomobject]@{
                Available = $true
                Entries = @([pscustomobject]@{ Name = 'Ubuntu'; Version = 2; IsDefault = $true })
            }
        }
        $env:GACHIPAD_WSL_FAKE_MODE = 'verbose-error'
        $output = Invoke-Installer 6>&1 | Out-String
        $output | Should -Match "Using WSL 2 distribution 'Ubuntu'"
    }

    It 'refuses a WSL 1 distribution with the conversion command' {
        $env:GACHIPAD_WSL_FAKE_MODE = 'wsl1'
        { Invoke-Installer } | Should -Throw '*wsl --set-version* 2*'
    }

    It 'selects the localized default distro using quiet names and the default marker' {
        $env:GACHIPAD_WSL_FAKE_MODE = 'localized'
        $output = Invoke-Installer 6>&1 | Out-String
        $output | Should -Match "Using WSL 2 distribution 'Ubuntu Work'"
        $records = @(Get-Content -LiteralPath $script:argvLog -Encoding UTF8 | ForEach-Object { ConvertFrom-Json $_ })
        $install = @($records | Where-Object { $_.Arguments -contains './install.sh' })
        $install[0].Arguments[1] | Should -Be 'Ubuntu Work'
    }

    It 'explains when Docker is not installed' {
        $env:GACHIPAD_WSL_FAKE_MODE = 'no-docker'
        { Invoke-Installer } | Should -Throw '*Docker is not available inside*'
    }

    It 'explains how to enable Docker Desktop WSL integration' {
        $env:GACHIPAD_WSL_FAKE_MODE = 'desktop-off'
        Mock Get-DockerDesktopStatus { [pscustomobject]@{ Installed = $true; Running = $true } }
        { Invoke-Installer } | Should -Throw '*WSL integration is off*'
    }

    It 'distinguishes a stopped Docker Desktop engine' {
        $env:GACHIPAD_WSL_FAKE_MODE = 'desktop-stopped'
        Mock Get-DockerDesktopStatus { [pscustomobject]@{ Installed = $true; Running = $false } }
        { Invoke-Installer } | Should -Throw '*Docker Desktop is installed but is not running*'
    }

    It 'explains Docker socket group permissions' {
        $env:GACHIPAD_WSL_FAKE_MODE = 'permission'
        { Invoke-Installer } | Should -Throw '*Add the WSL user to the docker group*'
    }

    It 'explains how to enable systemd for Docker Engine inside WSL' {
        $env:GACHIPAD_WSL_FAKE_MODE = 'engine-no-systemd'
        { Invoke-Installer } | Should -Throw '*without systemd*'
    }

    It 'warns about WSL NAT networking and prints both fixes' {
        $env:GACHIPAD_WSL_FAKE_MODE = 'nat'
        $output = Invoke-Installer 6>&1 | Out-String
        $output | Should -Match 'Other machines cannot reach ports published by Docker Engine inside WSL'
        $output | Should -Match 'networkingMode=mirrored'
        $output | Should -Match 'netsh interface portproxy add v4tov4'
    }

    It 'reports mirrored WSL networking without the NAT warning' {
        $env:GACHIPAD_WSL_FAKE_MODE = 'mirrored'
        $output = Invoke-Installer 6>&1 | Out-String
        $output | Should -Match 'WSL networking mode is mirrored'
        $output | Should -Not -Match 'Other machines cannot reach ports'
    }

    It 'does not change the firewall when -OpenFirewall is used without elevation' {
        $script:InstallerOptions.OpenFirewall = $true
        Mock Test-IsElevated { $false }
        Mock New-FirewallRule { }
        $output = Invoke-Installer 6>&1 | Out-String
        $output | Should -Match 'not elevated'
        Should -Invoke New-FirewallRule -Times 0 -Exactly
    }

    It 'replaces existing firewall rules with the requested ports and network profiles' {
        Mock Test-IsElevated { $true }
        Mock Get-FirewallRule { param($Name) [pscustomobject]@{ DisplayName = $Name } }
        Mock Remove-FirewallRule { }
        Mock New-FirewallRule { }
        $null = Invoke-FirewallSetup -HttpPort 8080 -HttpsPort 8443 -NetworkMode public
        Should -Invoke Remove-FirewallRule -Times 2 -Exactly
        Should -Invoke New-FirewallRule -Times 1 -Exactly -ParameterFilter {
            $Name -eq 'gachipad HTTP' -and $Port -eq '8080' -and ($Profiles -join ',') -eq 'Domain,Private,Public'
        }
        Should -Invoke New-FirewallRule -Times 1 -Exactly -ParameterFilter {
            $Name -eq 'gachipad HTTPS' -and $Port -eq '8443' -and ($Profiles -join ',') -eq 'Domain,Private,Public'
        }
        $null = Invoke-FirewallSetup -HttpPort 80 -HttpsPort 443 -NetworkMode internal
        Should -Invoke New-FirewallRule -Times 2 -Exactly -ParameterFilter { ($Profiles -join ',') -eq 'Domain,Private' }
    }

    It 'forwards parameters and adds --no-mdns by default' {
        $script:InstallerOptions.Db = 'sqlite'
        $script:InstallerOptions.DatabaseUrl = 'postgresql://u:p"a''ss$word@db.test/data?x=$HOME&y=$(false)'
        $script:InstallerOptions.Network = 'internal'
        $script:InstallerOptions.Domain = 'gachipad.example.test'
        $script:InstallerOptions.AcmeEmail = 'ops@example.test'
        $script:InstallerOptions.BehindProxy = '192.0.2.7/32'
        $script:InstallerOptions.InstallArgs = @('--extra-flag', 'extra-value')
        $output = Invoke-Installer 6>&1 | Out-String
        $log = Get-Content -LiteralPath $script:fakeLog -Encoding UTF8 -Raw
        $log | Should -Match '--db sqlite'
        $log | Should -Match '--network internal'
        $log | Should -Match '--domain gachipad\.example\.test'
        $log | Should -Match '--acme-email ops@example\.test'
        $log | Should -Match '--behind-proxy 192\.0\.2\.7/32'
        $log | Should -Match '--extra-flag extra-value'
        $log | Should -Match '--no-mdns'
        $log | Should -Not -Match '(^| )--mdns( |$)'
        $records = @(Get-Content -LiteralPath $script:argvLog -Encoding UTF8 | ForEach-Object { ConvertFrom-Json $_ })
        $install = @($records | Where-Object { $_.Arguments -contains './install.sh' })
        $install.Count | Should -Be 1
        $index = [Array]::IndexOf($install[0].Arguments, '--database-url')
        $install[0].Arguments[$index + 1] | Should -BeExactly $script:InstallerOptions.DatabaseUrl
        $output | Should -Match 'Gachipad URL: http://192\.0\.2\.20:8080'
    }

    It 'preserves explicitly forwarded --mdns' {
        $script:InstallerOptions.InstallArgs = @('--mdns')
        $null = Invoke-Installer 6>&1
        $log = Get-Content -LiteralPath $script:fakeLog -Encoding UTF8 -Raw
        $log | Should -Match '\./install\.sh --mdns(?:\r?\n|$)'
        $log | Should -Not -Match '--no-mdns'
    }

    It 'does not duplicate an explicitly forwarded --no-mdns' {
        $script:InstallerOptions.InstallArgs = @('--no-mdns')
        $null = Invoke-Installer 6>&1
        $records = @(Get-Content -LiteralPath $script:argvLog -Encoding UTF8 | ForEach-Object { ConvertFrom-Json $_ })
        $install = @($records | Where-Object { $_.Arguments -contains './install.sh' })
        @($install[0].Arguments | Where-Object { $_ -ceq '--no-mdns' }).Count | Should -Be 1
    }

    It 'warns when an archive has no checksum sidecar' {
        $archive = Join-Path $script:testRoot 'unsigned.tar.gz'
        [System.IO.File]::WriteAllText($archive, 'fixture')
        $warning = Test-BundleChecksum -Path $archive 3>&1 | Out-String
        $warning | Should -Match 'Bundle has no \.sha256 sidecar; checksum was not verified'
    }
}

Describe 'gachipad command wrapper' {
    BeforeEach {
        $statePath = Get-InstallStatePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $statePath) -Force | Out-Null
        [System.IO.File]::WriteAllText($statePath, '{"Distro":"Ubuntu","InstallDir":"/home/test/gachipad"}')
        [System.IO.File]::WriteAllText($script:fakeLog, '')
    }

    It 'refuses unknown script names and paths' {
        { Invoke-GachipadCommand -Name '../backup' } | Should -Throw '*Invalid script name*'
        { Invoke-GachipadCommand -Name 'rm' } | Should -Throw '*Unknown script*'
        { Invoke-GachipadCommand -Name 'UPDATE' } | Should -Throw '*Unknown script*'
    }

    It 'uses the destination when the WSL copy command returns null output' {
        Mock Get-WslPath { '/mnt/c/fake-source' }
        Mock Invoke-WslScript { [pscustomobject]@{ ExitCode = 0; Output = $null } }
        $path = Copy-InstallSourceToWsl -SelectedDistro Ubuntu -SourcePath $PSScriptRoot -SourceKind directory -Destination '~/gachipad'
        $path | Should -BeExactly '~/gachipad'
    }

    It 'runs an installed script from the saved WSL folder' {
        Invoke-GachipadCommand -Name 'backup'
        $log = Get-Content -LiteralPath $script:fakeLog -Encoding UTF8 -Raw
        $log | Should -Match '--cd /home/test/gachipad --exec ./backup\.sh'
    }
}
