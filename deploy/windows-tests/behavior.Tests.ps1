BeforeAll {
    $script:installPath = (Resolve-Path (Join-Path $PSScriptRoot '../install.ps1')).Path
    $script:wrapperPath = (Resolve-Path (Join-Path $PSScriptRoot '../gachipad.ps1')).Path
    . $script:installPath -NoRun
    . $script:wrapperPath -WrapperNoRun
    $script:root = Join-Path ([System.IO.Path]::GetTempPath()) ('gachipad-behavior-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $script:root | Out-Null
    $script:recorder = Join-Path $PSScriptRoot 'fake-wsl.ps1'
    $script:nativeWsl = Join-Path $PSScriptRoot 'native-wsl.py'
    $script:argvLog = Join-Path $script:root 'argv.jsonl'
    $script:previousLocalData = $env:LOCALAPPDATA
    $env:LOCALAPPDATA = $script:root
    $script:korean = -join ([char[]]@(0xAE40, 0x20, 0xD604, 0xBBFC))
    $script:database = 'postgresql://user:p"a''ss$word@example.test/db?x=$HOME&y=$(touch forbidden)'

    function Invoke-Entrypoint {
        param([string[]]$Arguments, [string]$FilePath = $script:wrapperPath)
        $start = New-Object System.Diagnostics.ProcessStartInfo
        $start.FileName = (Get-Process -Id $PID).Path
        $start.Arguments = (@('-NoLogo', '-NoProfile', '-File', $FilePath) + $Arguments |
            ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '
        $start.UseShellExecute = $false
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $process = [System.Diagnostics.Process]::Start($start)
        try {
            $stdout = $process.StandardOutput.ReadToEndAsync()
            $stderr = $process.StandardError.ReadToEndAsync()
            $process.WaitForExit()
            return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $stdout.Result + $stderr.Result }
        } finally { $process.Dispose() }
    }
}

AfterAll {
    $env:LOCALAPPDATA = $script:previousLocalData
    foreach ($name in @('GACHIPAD_WSL_EXE', 'GACHIPAD_WSL_ARGV_LOG', 'GACHIPAD_WSL_FAKE_MODE', 'GACHIPAD_TEST_SOURCE')) {
        Remove-Item ('Env:' + $name) -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $script:root -Recurse -Force
}

Describe 'Native argument and entrypoint regressions' {
    BeforeEach {
        $env:GACHIPAD_WSL_EXE = $script:recorder
        $env:GACHIPAD_WSL_ARGV_LOG = $script:argvLog
        $env:GACHIPAD_WSL_FAKE_MODE = 'success'
        [System.IO.File]::WriteAllText($script:argvLog, '')
        Write-InstallState -SelectedDistro 'Ubuntu' -Directory '/home/test/gachipad'
    }

    It 'delivers exact argv through a native process including quotes, empty strings and trailing backslashes' {
        $env:GACHIPAD_WSL_FAKE_MODE = 'record'
        $windowsPath = 'C:\Users\' + $script:korean + '\Downloads\gachipad 1.2\'
        $expected = @('-d', 'Ubuntu With Spaces', '--cd', '/home/test/a "quoted" folder', '--exec', './install.sh',
            '--database-url', $script:database, $windowsPath, '', 'two\\"quotes', 'ends\\')
        $result = Invoke-Wsl -Arguments $expected
        $result.ExitCode | Should -Be 23
        $result.Output | Should -Be 'native-output'
        $actual = (Get-Content -LiteralPath $script:argvLog -Encoding UTF8 -Raw | ConvertFrom-Json).Arguments
        $actual.Count | Should -Be $expected.Count
        for ($index = 0; $index -lt $expected.Count; $index++) { $actual[$index] | Should -BeExactly $expected[$index] }
    }

    It 'starts an accepted command through the public wrapper script' {
        $result = Invoke-Entrypoint -Arguments @('backup')
        $result.ExitCode | Should -Be 0
        $records = @(Get-Content -LiteralPath $script:argvLog -Encoding UTF8 | ForEach-Object { ConvertFrom-Json $_ })
        @($records[-1].Arguments) | Should -Contain './backup.sh'
        @($records[-1].Arguments) | Should -Contain '--exec'
    }

    It 'forwards short flags and the end-of-options marker through the public wrapper script' {
        $result = Invoke-Entrypoint -Arguments @('backup', '-d', '-v', '-e', 'x', '-f', '--', '--check')
        $result.ExitCode | Should -Be 0
        $records = @(Get-Content -LiteralPath $script:argvLog -Encoding UTF8 | ForEach-Object { ConvertFrom-Json $_ })
        $arguments = @($records[-1].Arguments)
        $scriptIndex = [Array]::IndexOf($arguments, './backup.sh')
        $forwarded = @($arguments[($scriptIndex + 1)..($arguments.Count - 1)])
        $expected = @('-d', '-v', '-e', 'x', '-f', '--', '--check')
        $forwarded.Count | Should -Be $expected.Count
        for ($index = 0; $index -lt $expected.Count; $index++) { $forwarded[$index] | Should -BeExactly $expected[$index] }
    }

    It 'reads UTF-8 saved distro and directory names through the public wrapper script' {
        $distro = 'Ubuntu ' + $script:korean
        $directory = '/home/' + $script:korean + '/gachipad 1.2'
        Write-InstallState -SelectedDistro $distro -Directory $directory
        (Invoke-Entrypoint -Arguments @('backup')).ExitCode | Should -Be 0
        $records = @(Get-Content -LiteralPath $script:argvLog -Encoding UTF8 | ForEach-Object { ConvertFrom-Json $_ })
        $records[-1].Arguments[1] | Should -BeExactly $distro
        $records[-1].Arguments[3] | Should -BeExactly $directory
    }

    It 'rejects unknown commands through the public wrapper script with exit 1' {
        $result = Invoke-Entrypoint -Arguments @('definitely-unknown-command')
        $result.ExitCode | Should -Be 1
        $result.Output | Should -Match 'Unknown script'
    }

    It 'starts logs through the public wrapper script' {
        (Invoke-Entrypoint -Arguments @('logs')).ExitCode | Should -Be 0
        $record = Get-Content -LiteralPath $script:argvLog -Encoding UTF8 -Raw | ConvertFrom-Json
        ($record.Arguments -join '|') | Should -Be '-d|Ubuntu|--cd|/home/test/gachipad|--exec|docker|compose|logs|-f'
    }

    It 'gives an actionable error for corrupt or unsupported saved state' {
        foreach ($json in @('{', '{}', '{"Distro":"Ubuntu"}', '{"Distro":3,"InstallDir":"/home/test"}',
                '{"Version":2,"Distro":"Ubuntu","InstallDir":"/home/test"}')) {
            [System.IO.File]::WriteAllText((Get-InstallStatePath), $json)
            { Invoke-GachipadCommand -Name backup } | Should -Throw '*saved installation file is invalid*Run install.ps1 again*'
        }
    }

    It 'fails a child process when the CI Pester command encounters a failing assertion' {
        $failure = Join-Path $script:root 'intentional.Tests.ps1'
        $gate = Join-Path $script:root 'ci-gate.ps1'
        [System.IO.File]::WriteAllText($failure, "Describe 'intentional gate probe' { It 'fails' { 1 | Should -Be 2 } }")
        [System.IO.File]::WriteAllText($gate, "Invoke-Pester -Path '$failure' -Output Detailed -CI")
        $result = Invoke-Entrypoint -FilePath $gate
        $result.ExitCode | Should -Be 1
        $result.Output | Should -Match 'Failed: 1'
        $workflow = Get-Content (Join-Path $PSScriptRoot '../../.github/workflows/ci.yml') -Raw
        $workflow | Should -Match 'Invoke-Pester -Path ./deploy/windows-tests -Output Detailed -CI'
    }

    It 'atomically replaces versioned state without temporary leftovers' {
        Write-InstallState -SelectedDistro 'Ubuntu 2' -Directory '/home/test/new folder'
        $state = Get-Content -LiteralPath (Get-InstallStatePath) -Encoding UTF8 -Raw | ConvertFrom-Json
        $state.Version | Should -Be 1
        $state.Distro | Should -Be 'Ubuntu 2'
        $state.InstallDir | Should -Be '/home/test/new folder'
        @(Get-ChildItem (Split-Path (Get-InstallStatePath)) -Filter '*.tmp').Count | Should -Be 0
    }

    It 'parses Korean, German and NUL-stripped verbose rows using quiet names and the version column' {
        $running = -join ([char[]]@(0xC2E4, 0xD589, 0x20, 0xC911))
        $stopped = -join ([char[]]@(0xC911, 0xC9C0, 0xB428))
        $header = -join ([char[]]@(0xC774, 0xB984, 0x20, 0xC0C1, 0xD0DC, 0x20, 0xBC84, 0xC804))
        foreach ($output in @("$header`n  Ubuntu Work $stopped 1`n* Ubuntu $running 2",
                "NAME STATUS VERSION`n  Ubuntu Work Beendet 1`n* Ubuntu Wird ausgefuehrt 2")) {
            $entries = Get-WslDistributionList -Output $output -Names @('Ubuntu', 'Ubuntu Work')
            $entries.Count | Should -Be 2
            $entries[0].IsDefault | Should -BeTrue
            $entries[0].Version | Should -Be 2
            $entries[1].Name | Should -Be 'Ubuntu Work'
            $entries[1].Version | Should -Be 1
            $bytes = [System.Text.Encoding]::Unicode.GetBytes($output)
            (ConvertFrom-WslOutput $bytes) | Should -BeExactly $output
            $entries = Get-WslDistributionList -Output (ConvertFrom-WslOutput $bytes) -Names @('Ubuntu', 'Ubuntu Work')
            $entries[0].Name | Should -Be 'Ubuntu'
        }
    }
}

Describe 'Real Linux shell regressions' -Skip:($env:OS -eq 'Windows_NT') {
    BeforeAll {
        & chmod +x $script:nativeWsl
        $script:source = Join-Path $script:root ('source ' + $script:korean + ' 1.2')
        New-Item -ItemType Directory -Path $script:source | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $script:source 'install.sh'), "#!/bin/bash`nexit 0`n")
        [System.IO.File]::WriteAllText((Join-Path $script:source 'images.tar'), 'fixture')
        Copy-Item (Join-Path $PSScriptRoot '../lib.sh') (Join-Path $script:source 'lib.sh')
    }

    BeforeEach {
        $env:GACHIPAD_WSL_EXE = $script:nativeWsl
        $env:GACHIPAD_TEST_SOURCE = $script:source
        Remove-Item Env:GACHIPAD_WSL_ARGV_LOG -ErrorAction SilentlyContinue
        $script:destination = Join-Path $script:root ('install ' + [guid]::NewGuid().ToString('N'))
    }

    It 'runs CRLF-source here-strings as LF stdin in a real Bash shell' {
        $bytes = [System.IO.File]::ReadAllBytes($script:installPath)
        [Array]::IndexOf($bytes, [byte]13) | Should -BeGreaterThan -1
        $result = Invoke-WslScript -SelectedDistro Ubuntu -ScriptText "set -eu`r`nprintf '%s' lf-works`r`n"
        $result.ExitCode | Should -Be 0
        $result.Output | Should -Be 'lf-works'
        $path = Copy-InstallSourceToWsl -SelectedDistro Ubuntu -SourcePath $script:source -SourceKind directory -Destination $script:destination
        $path | Should -BeExactly $script:destination
        Test-Path (Join-Path $path 'install.sh') | Should -BeTrue
    }

    It 'preserves existing .env bytes when copying a real directory' {
        New-Item -ItemType Directory -Path $script:destination | Out-Null
        $saved = "DATABASE_URL='keep `$values and quotes'`n"
        [System.IO.File]::WriteAllText((Join-Path $script:destination '.env'), $saved)
        [System.IO.File]::WriteAllText((Join-Path $script:source '.env'), 'DATABASE_URL=must-not-copy')
        try {
            $null = Copy-InstallSourceToWsl -SelectedDistro Ubuntu -SourcePath $script:source -SourceKind directory -Destination $script:destination
            [System.IO.File]::ReadAllText((Join-Path $script:destination '.env')) | Should -BeExactly $saved
        } finally { Remove-Item (Join-Path $script:source '.env') -Force }
    }

    It 'rejects actual CR-containing copied shell files' {
        $bad = Join-Path $script:source 'bad.sh'
        [System.IO.File]::WriteAllText($bad, "#!/bin/sh`r`nexit 0`r`n")
        try {
            { Copy-InstallSourceToWsl -SelectedDistro Ubuntu -SourcePath $script:source -SourceKind directory -Destination $script:destination } |
                Should -Throw '*A copied .sh file has CR line endings*'
        } finally { Remove-Item $bad }
    }

    It 'reads fresh and quoted settings using the real Bash-only lib without executing .env' {
        (Get-ExistingDatabaseUrl -SelectedDistro Ubuntu -Directory $script:source) | Should -Be ''
        $config = Get-InstallConfig -SelectedDistro Ubuntu -Directory $script:source
        $config.HttpPort | Should -Be '80'
        $config.HttpsPort | Should -Be '443'
        $file = Join-Path $script:source '.env'
        $value = $script:database.Replace("'", "\'")
        [System.IO.File]::WriteAllText($file, "DATABASE_URL='$value'`nPUBLIC_URL='https://gachipad.test/a path'`nHTTP_PORT=8080`nHTTPS_PORT=8443`nGACHIPAD_NETWORK=public`nTHIS_IS_NOT_SHELL syntax`n")
        try {
            (Get-ExistingDatabaseUrl -SelectedDistro Ubuntu -Directory $script:source) | Should -BeExactly $script:database
            $config = Get-InstallConfig -SelectedDistro Ubuntu -Directory $script:source
            $config.PublicUrl | Should -Be 'https://gachipad.test/a path'
            $config.HttpPort | Should -Be '8080'
            $config.HttpsPort | Should -Be '8443'
            $config.Network | Should -Be 'public'
            Test-Path (Join-Path $script:source 'forbidden') | Should -BeFalse
        } finally { Remove-Item $file -Force }
    }

    It 'preserves special arguments all the way to the Linux program' {
        $values = @($script:database, ('C:\Users\' + $script:korean + '\Downloads\gachipad 1.2\'), '', 'quoted "value"')
        $result = Invoke-Wsl -Arguments (@('-d', 'Ubuntu', '--exec', 'python3', '-c', 'import json,sys; print(json.dumps(sys.argv[1:],ensure_ascii=False))') + $values)
        $result.ExitCode | Should -Be 0
        $actual = @($result.Output | ConvertFrom-Json)
        $actual.Count | Should -Be $values.Count
        for ($index = 0; $index -lt $values.Count; $index++) { $actual[$index] | Should -BeExactly $values[$index] }
    }

    It 'runs the actual wrapper listing and requested script with preserved arguments and exit handling' {
        $backup = Join-Path $script:source 'backup.sh'
        $body = @'
#!/bin/bash
printf '%s\n' "$@" > "$(dirname "$0")/backup-args"
echo requested-script-ran
exit 17
'@
        [System.IO.File]::WriteAllText($backup, $body.Replace("`r", '') + "`n")
        & chmod +x $backup
        Write-InstallState -SelectedDistro Ubuntu -Directory $script:source
        try {
            $result = Invoke-Entrypoint -Arguments @('backup', 'arg with spaces', $script:database)
            $result.ExitCode | Should -Be 1
            $result.Output | Should -Match 'requested-script-ran'
            $result.Output | Should -Match 'backup.sh exited with code 17'
            $actual = @(Get-Content (Join-Path $script:source 'backup-args'))
            $actual.Count | Should -Be 2
            $actual[0] | Should -Be 'arg with spaces'
            $actual[1] | Should -BeExactly $script:database
        } finally {
            Remove-Item $backup -Force
            Remove-Item (Join-Path $script:source 'backup-args') -Force -ErrorAction SilentlyContinue
        }
    }

    It 'decodes actual UTF-16LE native output including Korean characters' {
        $expected = 'Ubuntu ' + $script:korean
        $result = Invoke-Wsl -Arguments @('--utf16', $expected)
        $result.ExitCode | Should -Be 0
        $result.Output | Should -BeExactly $expected
    }

    It 'refuses a destination symlink resolving into /mnt before copying' {
        $link = Join-Path $script:root ('linked-' + [guid]::NewGuid().ToString('N'))
        & ln -s /mnt $link
        try {
            { Copy-InstallSourceToWsl -SelectedDistro Ubuntu -SourcePath $script:source -SourceKind directory -Destination ($link + '/gachipad-refused') } |
                Should -Throw '*WSL Linux filesystem*'
            Test-Path ($link + '/gachipad-refused') | Should -BeFalse
        } finally { Remove-Item $link }
    }

    It 'refuses supported WSL mount types at nonstandard mount points using the real copy shell' {
        $bin = Join-Path $script:root 'bin'
        New-Item -ItemType Directory -Path $bin -Force | Out-Null
        $stat = Join-Path $bin 'stat'
        $oldPath = $env:PATH
        try {
            $env:PATH = $bin + ':' + $oldPath
            foreach ($filesystem in @('9p', 'drvfs', 'v9fs', 'virtiofs', 'fuseblk')) {
                [System.IO.File]::WriteAllText($stat, "#!/bin/sh`nprintf '%s' $filesystem`n")
                & chmod +x $stat
                { Copy-InstallSourceToWsl -SelectedDistro Ubuntu -SourcePath $script:source -SourceKind directory -Destination $script:destination } |
                    Should -Throw '*WSL Linux filesystem*'
                Test-Path $script:destination | Should -BeFalse
            }
        } finally { $env:PATH = $oldPath; Remove-Item $bin -Recurse -Force }
    }

    It 'builds a fixture repository bundle through the real copy, bundling and tar programs' {
        $repository = Join-Path $script:root 'repository'
        $deploy = Join-Path $repository 'deploy'
        New-Item -ItemType Directory -Path $deploy -Force | Out-Null
        Copy-Item (Join-Path $script:source '*') $deploy
        $bundleScript = @'
#!/bin/bash
set -eu
cat >/dev/null
[ ! -e ../.env ]
mkdir -p dist stage/gachipad
cp install.sh images.tar lib.sh stage/gachipad/
tar -czf dist/gachipad-fixture.tar.gz -C stage gachipad
'@
        [System.IO.File]::WriteAllText((Join-Path $deploy 'bundle.sh'), $bundleScript.Replace("`r", '') + "`n")
        [System.IO.File]::WriteAllText((Join-Path $repository '.env'), 'must-not-stage')
        & chmod +x (Join-Path $deploy 'bundle.sh')
        $env:GACHIPAD_TEST_SOURCE = $repository
        $path = Copy-InstallSourceToWsl -SelectedDistro Ubuntu -SourcePath $repository -SourceKind repository -Destination $script:destination
        Test-Path (Join-Path $path 'install.sh') | Should -BeTrue
        Test-Path (Join-Path $path '.env') | Should -BeFalse
        @(Get-ChildItem $script:root -Filter '*.source.*').Count | Should -Be 0
    }

    It 'inherits a real TTY and shows live output before input while returning only status' {
        $probe = Join-Path $script:root 'console.ps1'
        $shell = '[ -t 0 ] && [ -t 1 ] || exit 99; printf "LIVE-TTY\n"; read -r answer; [ "$answer" = continue ] || exit 98; exit 17'
        $body = ". '$($script:installPath)' -NoRun`n" +
            "`$result = Invoke-Wsl -Arguments @('-d', 'Ubuntu', '--exec', 'bash', '-c', '" + $shell.Replace("'", "''") + "') -PassThruConsole`n" +
            "if (`$result -is [array] -or `$result.ExitCode -ne 17 -or `$result.Output -ne '') { exit 97 }`nWrite-Output 'STATUS-ONLY'`n"
        [System.IO.File]::WriteAllText($probe, $body)
        $result = Invoke-Wsl -Arguments @('--pty', (Get-Process -Id $PID).Path, '-NoLogo', '-NoProfile', '-File', $probe)
        $result.ExitCode | Should -Be 0
        $result.Output | Should -Match 'LIVE-TTY'
        $result.Output | Should -Match 'STATUS-ONLY'
    }

    It 'refuses staged CR line endings before replacing an existing install' {
        $destinationInstall = Join-Path $script:destination 'install.sh'
        New-Item -ItemType Directory -Path $script:destination -Force | Out-Null
        $working = "#!/bin/bash`nexit 7`n"
        [System.IO.File]::WriteAllText($destinationInstall, $working)
        $sourceInstall = Join-Path $script:source 'install.sh'
        $originalBytes = [System.IO.File]::ReadAllBytes($sourceInstall)
        try {
            [System.IO.File]::WriteAllBytes($sourceInstall, [System.Text.Encoding]::UTF8.GetBytes("#!/bin/bash`r`nexit 0`r`n"))
            { Copy-InstallSourceToWsl -SelectedDistro Ubuntu -SourcePath $script:source -SourceKind directory -Destination $script:destination } |
                Should -Throw '*A copied .sh file has CR line endings*'
            [System.IO.File]::ReadAllText($destinationInstall) | Should -BeExactly $working
        } finally {
            [System.IO.File]::WriteAllBytes($sourceInstall, $originalBytes)
        }
    }
}

Describe 'Windows batch entrypoint' -Skip:($env:OS -ne 'Windows_NT') {
    It 'returns failure after the failure pause' {
        $start = New-Object System.Diagnostics.ProcessStartInfo
        $start.FileName = (Get-Command 'cmd.exe' -ErrorAction Stop).Source
        $start.Arguments = '/d /c call "' + (Join-Path $PSScriptRoot '../install.cmd') + '"'
        $start.UseShellExecute = $false
        $start.RedirectStandardInput = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.EnvironmentVariables['GACHIPAD_WSL_EXE'] = $script:recorder
        $start.EnvironmentVariables['GACHIPAD_WSL_FAKE_MODE'] = 'no-wsl'
        $process = [System.Diagnostics.Process]::Start($start)
        try {
            $process.StandardInput.WriteLine('')
            $process.StandardInput.Close()
            $process.WaitForExit()
            $process.ExitCode | Should -Be 1
        } finally { $process.Dispose() }
    }
}
