# flash-probe.ps1 -- collect evidence for "auto download works / does not work" comparison.
# ASCII only (PowerShell 5.1 safe). Does NOT erase flash and does NOT change partition layout.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\tools\flash-probe.ps1 -Port COM3
#   powershell -ExecutionPolicy Bypass -File .\tools\flash-probe.ps1 -Port COM3 -OutDir C:\tmp\report
#
# Output: <OutDir>\summary.txt plus raw logs in <OutDir>\logs\.
# Send the whole <OutDir> back (zip) for comparison between machines.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Port,

    [int]$Baud = 115200,

    [string]$OutDir = ".\flashing-report",

    [switch]$SkipUpload
)

$ErrorActionPreference = "Continue"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LogDir = Join-Path $OutDir "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$script:Summary = New-Object System.Collections.Generic.List[string]

function Say([string]$text) {
    Write-Host $text
    $script:Summary.Add($text)
}

function Find-Tool([string]$name) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

# ---------------------------------------------------------------- environment
Say "=== 1) environment ==="

$os = Get-CimInstance Win32_OperatingSystem
Say ("OS          : {0} {1} (build {2})" -f $os.Caption, $os.Version, $os.BuildNumber)
Say ("PowerShell  : {0}" -f $PSVersionTable.PSVersion)

$cli = $null
$cliCandidates = @(
    (Join-Path $Root "resources\arduino-cli\arduino-cli.exe"),
    (Join-Path ${env:ProgramFiles} "Arduino CLI\arduino-cli.exe"),
    (Join-Path ${env:ProgramFiles} "Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Arduino CLI\arduino-cli.exe")
)
foreach ($cand in $cliCandidates) {
    if ($cand -and (Test-Path $cand)) { $cli = $cand; break }
}
if (-not $cli) { $cli = Find-Tool "arduino-cli" }
if ($cli) {
    $cliVer = (& $cli version 2>&1 | Out-String).Trim()
    Say ("arduino-cli : {0}  ({1})" -f $cli, $cliVer)
    & $cli core list 2>&1 | Out-File -Encoding utf8 (Join-Path $LogDir "core-list.txt")
} else {
    Say "arduino-cli : NOT FOUND"
}

$esptool = $null
$coreRoot = Join-Path $env:LOCALAPPDATA "Arduino15\packages\esp32\tools\esptool_py"
if (Test-Path $coreRoot) {
    $esptool = Get-ChildItem -Path $coreRoot -Recurse -Filter "esptool.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $esptool) { $esptool = Find-Tool "esptool" }
if ($esptool) {
    $esVer = (& $esptool version 2>&1 | Out-String).Trim()
    Say ("esptool     : {0}  ({1})" -f $esptool, $esVer)
} else {
    Say "esptool     : NOT FOUND"
    Say "STOP: esptool missing, install esp32 core first."
    $script:Summary -join "`r`n" | Set-Content -Encoding utf8 (Join-Path $OutDir "summary.txt")
    exit 1
}

Say ("port        : {0}" -f $Port)
$ports = Get-CimInstance Win32_SerialPort -ErrorAction SilentlyContinue |
    Select-Object DeviceID, Name, PNPDeviceID
$ports | Format-List | Out-String | Tee-Object -Variable portText | Out-Null
$portText.Trim() | ForEach-Object { Say $_ }
$ports | Format-List | Out-File -Encoding utf8 (Join-Path $LogDir "serial-ports.txt")

$drv = Get-CimInstance Win32_PnPSignedDriver -ErrorAction SilentlyContinue |
    Where-Object { $_.DeviceName -match "CP210|Silicon Labs" } |
    Select-Object DeviceName, DriverVersion, DriverDate, InfName
Say "--- driver ---"
$drv | Format-List | Out-String | Tee-Object -Variable drvText | Out-Null
$drvText.Trim() | ForEach-Object { Say $_ }
$drv | Format-List | Out-File -Encoding utf8 (Join-Path $LogDir "driver.txt")

# ---------------------------------------------------------------- auto reset test
Say ""
Say "=== 2) auto download test (default reset, no button) ==="
$autoLog = Join-Path $LogDir "auto-chip-id.txt"
$autoOut = & $esptool --chip esp32 -p $Port -b 921600 -v --before default-reset chip-id 2>&1 | Out-String
$autoOut | Out-File -Encoding utf8 $autoLog
$autoOk = ($autoOut -match "Chip type:") -and ($autoOut -match "Chip is ESP32")
if ($autoOk) {
    Say "RESULT: AUTO-OK -- esptool connected without pressing any button."
} else {
    Say "RESULT: AUTO-FAIL -- see logs\auto-chip-id.txt"
    if ($autoOut -match "Wrong boot mode detected \(0x([0-9a-fA-F]+)\)") {
        Say ("        boot mode seen: 0x{0}" -f $Matches[1])
    }
    if ($autoOut -match "could not open port|Access is denied|PermissionError") {
        Say "        NOTE: port could not be opened -- close serial monitor / other tools."
    }
}

# ---------------------------------------------------------------- line sequence probe
Say ""
Say "=== 3) DTR/RTS line sequence probe ==="

function Invoke-Sequence {
    param([string]$Label, [object[]]$Steps)

    $p = New-Object System.IO.Ports.SerialPort($Port, $Baud)
    $p.ReadTimeout = 200
    try {
        $p.Open()
        $p.DiscardInBuffer()
        foreach ($s in $Steps) {
            $p.DtrEnable = [bool]$s[0]
            $p.RtsEnable = [bool]$s[1]
            Start-Sleep -Milliseconds ([int]$s[2])
        }
        $p.DtrEnable = $false
        $p.RtsEnable = $false
        Start-Sleep -Milliseconds 60
        $buf = New-Object System.Text.StringBuilder
        $deadline = (Get-Date).AddMilliseconds(1500)
        while ((Get-Date) -lt $deadline) {
            try { [void]$buf.Append($p.ReadExisting()) } catch { }
            Start-Sleep -Milliseconds 40
        }
        $p.Close()
        $text = $buf.ToString()
        $boot = "none"
        $m = [regex]::Match($text, "boot:0x[0-9a-fA-F]+")
        if ($m.Success) { $boot = $m.Value }
        $dl = if ($text -match "waiting for download") { "DOWNLOAD" } else { "-" }
        Say ("  {0,-22} boot={1,-10} download={2}" -f $Label, $boot, $dl)
        $text | Out-File -Encoding utf8 (Join-Path $LogDir ("seq-" + ($Label -replace "[^A-Za-z0-9]", "_") + ".txt"))
    } catch {
        Say ("  {0,-22} OPEN-ERROR: {1}" -f $Label, $_.Exception.Message)
        try { $p.Close() } catch { }
    }
    Start-Sleep -Milliseconds 300
}

Invoke-Sequence "only-DTR"     @(@($true,  $false, 200))
Invoke-Sequence "only-RTS"     @(@($false, $true,  200))
Invoke-Sequence "esptool-std"  @(@($false, $false, 50), @($false, $true, 100), @($true, $false, 60))
Invoke-Sequence "swapped"      @(@($true,  $false, 100), @($false, $true, 60), @($false, $false, 50))
Invoke-Sequence "both-high"    @(@($true,  $false, 60), @($true, $true, 100), @($false, $false, 60))

# ---------------------------------------------------------------- optional: real upload
Say ""
if ($SkipUpload) {
    Say "=== 4) upload test: skipped (-SkipUpload) ==="
} elseif (-not $cli) {
    Say "=== 4) upload test: skipped (arduino-cli not found) ==="
} else {
    Say "=== 4) upload test (examples\01_blink_rgb, arduino-cli default speed) ==="
    $upLog = Join-Path $LogDir "upload-01.txt"
    $upOut = & $cli upload --fqbn esp32:esp32:esp32 --port $Port (Join-Path $Root "examples\01_blink_rgb") 2>&1 | Out-String
    $upOut | Out-File -Encoding utf8 $upLog
    if ($upOut -match "Hash of data verified") {
        Say "RESULT: UPLOAD-OK"
    } else {
        Say "RESULT: UPLOAD-FAIL -- see logs\upload-01.txt"
    }
    foreach ($line in ($upOut -split "`r?`n")) {
        if ($line -match "Connecting|Connected to|Wrong boot mode|fatal error|Wrote |Hash of data") {
            Say ("        " + $line.Trim())
        }
    }
}

Say ""
Say "=== done ==="
Say ("report dir: {0}" -f (Resolve-Path $OutDir).Path)
$script:Summary -join "`r`n" | Set-Content -Encoding utf8 (Join-Path $OutDir "summary.txt")
