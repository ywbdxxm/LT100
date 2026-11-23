# LT100 environment checker for a fresh Windows machine.
# ASCII only on purpose: Windows PowerShell 5.1 misparses BOM-less UTF-8 scripts.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\check-env.ps1
#   ... -OutFile .\env-report.txt
#
# Exit code: 0 = no required item missing, 1 = something required missing.

[CmdletBinding()]
param(
    [string]$OutFile = ''
)

$ErrorActionPreference = 'Continue'
$script:rows = @()

function Add-Row {
    param([string]$Area, [string]$Item, [string]$Status, [string]$Detail)
    $script:rows += [pscustomobject]@{ Area = $Area; Item = $Item; Status = $Status; Detail = $Detail }
}

# ---------- 1. Windows ----------
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
if ($os) {
    Add-Row 'OS' 'Windows' 'OK' ("{0} {1} (build {2})" -f $os.Caption, $os.Version, $os.BuildNumber)
} else {
    Add-Row 'OS' 'Windows' 'WARN' 'cannot query Win32_OperatingSystem'
}
Add-Row 'OS' 'PowerShell' 'INFO' ("{0} / {1}" -f $PSVersionTable.PSVersion, [System.Environment]::Version)

# ---------- 2. Arduino IDE ----------
$ideCandidates = @(
    (Join-Path $env:ProgramFiles 'Arduino IDE\Arduino IDE.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Arduino IDE\Arduino IDE.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Arduino IDE\Arduino IDE.exe')
)
$ide = $null
foreach ($c in $ideCandidates) { if ($c -and (Test-Path $c)) { $ide = $c; break } }
if ($ide) {
    $pkg = Join-Path (Split-Path $ide) 'resources\app\package.json'
    $ver = 'unknown'
    if (Test-Path $pkg) {
        try { $ver = (Get-Content $pkg -Raw | ConvertFrom-Json).version } catch { }
    }
    Add-Row 'Arduino IDE' 'IDE 2.x' 'OK' ("{0} (v{1})" -f $ide, $ver)
} else {
    Add-Row 'Arduino IDE' 'IDE 2.x' 'MISSING' 'install Arduino IDE 2.x (resources\ installer, /S for silent)'
}

# ---------- 3. arduino-cli ----------
$cliCandidates = @(
    (Join-Path $PSScriptRoot '..\resources\arduino-cli\arduino-cli.exe'),
    'C:\Program Files\Arduino CLI\arduino-cli.exe',
    (Join-Path $env:ProgramFiles 'Arduino CLI\arduino-cli.exe')
)
$cli = $null
foreach ($c in $cliCandidates) { if ($c -and (Test-Path $c)) { $cli = (Resolve-Path $c).Path; break } }
if (-not $cli) {
    $cmd = Get-Command arduino-cli -ErrorAction SilentlyContinue
    if ($cmd) { $cli = $cmd.Source }
}
if ($cli) {
    $cliVer = (& $cli version 2>&1 | Out-String)
    $cliVer = ($cliVer -replace '\s+', ' ').Trim()
    Add-Row 'arduino-cli' 'CLI' 'OK' ("{0} | {1}" -f $cli, $cliVer)
} else {
    Add-Row 'arduino-cli' 'CLI' 'MISSING' 'no arduino-cli found (resources\arduino-cli, Program Files or PATH)'
}

# ---------- 4. ESP32 core ----------
$coreOk = $false
if ($cli) {
    $coreOut = (& $cli core list 2>&1 | Out-String)
    $esp = [regex]::Match($coreOut, '(?m)^\s*esp32:esp32\s+(\S+)')
    $avr = [regex]::Match($coreOut, '(?m)^\s*arduino:avr\s+(\S+)')
    if ($esp.Success) {
        if ($esp.Groups[1].Value -eq '4.0.0') {
            Add-Row 'ESP32 core' 'esp32:esp32' 'OK' ("version {0}" -f $esp.Groups[1].Value)
            $coreOk = $true
        } else {
            Add-Row 'ESP32 core' 'esp32:esp32' 'WARN' ("version {0}, expected 4.0.0" -f $esp.Groups[1].Value)
            $coreOk = $true
        }
    } else {
        Add-Row 'ESP32 core' 'esp32:esp32' 'MISSING' 'copy resources\arduino-offline\Arduino15 to %LOCALAPPDATA%\Arduino15'
    }
    if ($avr.Success) {
        Add-Row 'ESP32 core' 'arduino:avr' 'OK' ("version {0} (IDE first-run dependency)" -f $avr.Groups[1].Value)
    } else {
        Add-Row 'ESP32 core' 'arduino:avr' 'WARN' 'missing; first IDE launch may try to download it'
    }
} else {
    Add-Row 'ESP32 core' 'esp32:esp32' 'UNKNOWN' 'skipped: no arduino-cli'
}

# ---------- 5. Libraries ----------
$libRoot = Join-Path $env:USERPROFILE 'Documents\Arduino\libraries'
$installed = @{}
if (Test-Path $libRoot) {
    foreach ($dir in Get-ChildItem -Path $libRoot -Directory -ErrorAction SilentlyContinue) {
        $prop = Join-Path $dir.FullName 'library.properties'
        if (Test-Path $prop) {
            $name = ''; $ver = ''
            foreach ($line in Get-Content $prop) {
                if ($line -match '^name=(.+)$') { $name = $Matches[1].Trim() }
                if ($line -match '^version=(.+)$') { $ver = $Matches[1].Trim() }
            }
            if ($name) { $installed[$name] = $ver }
        }
    }
} else {
    Add-Row 'Libraries' 'Documents\Arduino\libraries' 'MISSING' 'directory does not exist (copy resources\arduino-offline\user-libraries)'
}

$required = [ordered]@{
    'SCServo'              = '1.0.2'
    'U8g2'                 = '2.36.19'
    'Adafruit NeoPixel'    = '1.15.5'
    'Adafruit SSD1306'     = '2.5.17'
    'Adafruit GFX Library' = '1.13.0'
    'Adafruit BusIO'       = '1.17.4'
}
foreach ($k in $required.Keys) {
    $want = $required[$k]
    $hit = $null
    foreach ($name in $installed.Keys) {
        if ($name -ieq $k) { $hit = $name; break }
    }
    if ($hit) {
        $got = $installed[$hit]
        if ($got -eq $want) {
            Add-Row 'Libraries' $k 'OK' ("version {0}" -f $got)
        } else {
            Add-Row 'Libraries' $k 'WARN' ("version {0}, expected {1}" -f $got, $want)
        }
    } else {
        Add-Row 'Libraries' $k 'MISSING' ("not installed (expected {0})" -f $want)
    }
}

# ---------- 6. LT100 platform libraries ----------
$repoCore = Join-Path $PSScriptRoot '..\platform\libraries\lt100_core\src\LT100Core.h'
$repoBoard = Join-Path $PSScriptRoot '..\platform\libraries\lt100_board\src\LT100Board.h'
$copiedCore = Join-Path $libRoot 'lt100_core\src\LT100Core.h'
$copiedBoard = Join-Path $libRoot 'lt100_board\src\LT100Board.h'
if ((Test-Path $repoCore) -and (Test-Path $repoBoard)) {
    Add-Row 'LT100 libs' 'in repo (platform\libraries)' 'OK' 'lt100_core + lt100_board present'
} else {
    Add-Row 'LT100 libs' 'in repo (platform\libraries)' 'MISSING' 'platform\libraries\lt100_core or lt100_board missing'
}
if ((Test-Path $copiedCore) -and (Test-Path $copiedBoard)) {
    Add-Row 'LT100 libs' 'installed for Arduino' 'OK' 'lt100_core + lt100_board in Documents\Arduino\libraries'
} else {
    Add-Row 'LT100 libs' 'installed for Arduino' 'WARN' 'needed for 09 only: copy platform\libraries\lt100_core and lt100_board'
}

# ---------- 7. CP210x driver and COM port ----------
$drvOut = (& pnputil /enum-drivers 2>&1 | Out-String)
if ($drvOut -match 'silabser') {
    Add-Row 'USB driver' 'CP210x (silabser.inf)' 'OK' 'Silicon Labs serial driver present'
} else {
    Add-Row 'USB driver' 'CP210x (silabser.inf)' 'MISSING' 'install resources\CP210x_Universal_Windows_Driver\silabser.inf'
}
$ports = @(Get-CimInstance Win32_SerialPort -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'CP210' })
if ($ports.Count -gt 0) {
    $p = $ports[0]
    Add-Row 'USB driver' 'Board port' 'OK' ("{0} ({1})" -f $p.DeviceID, $p.Name)
} else {
    Add-Row 'USB driver' 'Board port' 'WARN' 'no CP210x COM port now (board unplugged?)'
}

# ---------- 8. Browser for the web console ----------
$edge = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
$chrome = Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'
$browser = $null
$browserName = ''
if (Test-Path $edge) { $browser = $edge; $browserName = 'Edge' }
elseif (Test-Path $chrome) { $browser = $chrome; $browserName = 'Chrome' }
if ($browser) {
    $bv = (Get-Item $browser).VersionInfo.ProductVersion
    Add-Row 'Web console' $browserName 'OK' ("v{0} (Web Serial supported)" -f $bv)
} else {
    Add-Row 'Web console' 'Edge/Chrome' 'MISSING' 'install Edge or Chrome (Web Serial needs Chromium 89+)'
}
Add-Row 'Web console' 'Local server' 'INFO' 'tools\web-console.ps1, no admin needed, 127.0.0.1 only'

# ---------- 9. Developer-only tools ----------
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { Add-Row 'Dev only' 'node' 'OK' $node.Source } else { Add-Row 'Dev only' 'node' 'INFO' 'needed only for platform\tests\web' }
$cl = Get-Command cl -ErrorAction SilentlyContinue
if ($cl) { Add-Row 'Dev only' 'MSVC cl.exe' 'OK' $cl.Source } else { Add-Row 'Dev only' 'MSVC cl.exe' 'INFO' 'needed only for platform\tests\host' }
$gpp = Get-Command g++ -ErrorAction SilentlyContinue
if ($gpp) { Add-Row 'Dev only' 'g++' 'OK' $gpp.Source } else { Add-Row 'Dev only' 'g++' 'INFO' 'alternative for host tests' }

# ---------- report ----------
$lines = @()
$lines += 'LT100 environment check'
$lines += ('time: {0}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
$lines += ''
foreach ($r in $script:rows) {
    $lines += ('[{0,-7}] {1,-12} {2,-34} {3}' -f $r.Status, $r.Area, $r.Item, $r.Detail)
}
$missing = @($script:rows | Where-Object { $_.Status -eq 'MISSING' })
$warn = @($script:rows | Where-Object { $_.Status -eq 'WARN' })
$lines += ''
$lines += ('summary: {0} rows, {1} missing, {2} warnings' -f $script:rows.Count, $missing.Count, $warn.Count)
$text = $lines -join [Environment]::NewLine
Write-Output $text
if ($OutFile) {
    $text | Out-File -FilePath $OutFile -Encoding utf8
    Write-Output ('report written: {0}' -f (Resolve-Path $OutFile).Path)
}
if ($missing.Count -gt 0) { exit 1 } else { exit 0 }
