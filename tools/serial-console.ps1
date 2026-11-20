# LT100 serial console host tool
# Windows PowerShell 5.1+ / PowerShell 7, no Python or extra packages.
#
# Examples:
#   .\serial-console.ps1 -List
#   .\serial-console.ps1 -Port COMx
#   .\serial-console.ps1 -Port COMx -Demo

[CmdletBinding()]
param(
    [string]$Port,
    [int]$Baud = 115200,
    [switch]$List,
    [switch]$Demo
)

$ErrorActionPreference = 'Stop'

function Get-Lt100Ports {
    $result = @()
    $pnps = Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match 'CP210x|Silicon Labs' }
    foreach ($p in $pnps) {
        if ($p.Name -match '\((COM\d+)\)') {
            $result += [pscustomobject]@{ Port = $Matches[1]; Name = $p.Name }
        }
    }
    if ($result.Count -eq 0) {
        foreach ($name in [System.IO.Ports.SerialPort]::GetPortNames()) {
            $result += [pscustomobject]@{ Port = $name; Name = 'serial port' }
        }
    }
    return $result
}

if ($List) {
    $ports = Get-Lt100Ports
    if ($ports.Count -eq 0) {
        Write-Host 'No COM ports found.' -ForegroundColor Yellow
    } else {
        $ports | Format-Table -AutoSize
    }
    return
}

if (-not $Port) {
    $candidates = @(Get-Lt100Ports)
    if ($candidates.Count -eq 1) {
        $Port = $candidates[0].Port
        Write-Host "Using $Port ($($candidates[0].Name))" -ForegroundColor DarkGray
    } else {
        $candidates | Format-Table -AutoSize
        $Port = Read-Host 'COM port'
    }
}

if (-not $Port) {
    throw 'No COM port selected.'
}

$serial = [System.IO.Ports.SerialPort]::new($Port, $Baud, 'None', 8, 'One')
$serial.ReadTimeout = 200
$serial.WriteTimeout = 500
$serial.NewLine = "`n"

function Read-Replies([int]$timeoutMs = 500) {
    $deadline = [DateTime]::Now.AddMilliseconds($timeoutMs)
    while ([DateTime]::Now -lt $deadline) {
        try {
            $line = $serial.ReadLine()
            if ($null -ne $line) {
                $line = $line.TrimEnd("`r")
                if ($line.Length -gt 0) {
                    Write-Host "  $line" -ForegroundColor Gray
                }
            }
        } catch [System.TimeoutException] {
            # Keep waiting: STREAM telemetry arrives once per second.
            continue
        }
    }
}

function Send-Command([string]$command, [int]$waitMs = 350) {
    Write-Host "LT100> $command" -ForegroundColor Cyan
    $serial.WriteLine($command)
    Read-Replies $waitMs
}

try {
    $serial.Open()
    Write-Host "Connected to $Port at $Baud 8N1" -ForegroundColor Green
    Start-Sleep -Milliseconds 1200
    Read-Replies 500

    if ($Demo) {
        Send-Command 'PING'
        Send-Command 'INFO'
        Send-Command 'MODE RAINBOW'
        Send-Command 'BRIGHT 20'
        Send-Command 'TEXT HELLO'
        Send-Command 'COLOR FF6600'
        Send-Command 'STAT'
        Send-Command 'STREAM 1' 250
        Read-Replies 2500
        Send-Command 'STREAM 0'
        Send-Command 'MODE BREATHE'
        Send-Command 'BRIGHT 30'
        Send-Command 'STAT'
        Send-Command 'MODE SOLID'
        Send-Command 'COLOR 00FF00'
        Send-Command 'CLEAR'
        Write-Host 'Demo complete. Board left in SOLID green.' -ForegroundColor Green
        return
    }

    Write-Host 'Type HELP for commands, quit to exit.' -ForegroundColor DarkGray
    while ($true) {
        $command = Read-Host 'LT100>'
        if ($null -eq $command) { break }
        $command = $command.Trim()
        if ($command -eq '') { continue }
        if ($command -in @('quit', 'exit', 'q')) { break }
        Send-Command $command
    }
} finally {
    if ($serial.IsOpen) { $serial.Close() }
    Write-Host 'Serial port closed.' -ForegroundColor DarkGray
}
