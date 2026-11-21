# LT100 local serial bridge: opens the CP210x once and exposes it over WebSocket.
# The page talks to ws://127.0.0.1:8771/serial instead of Web Serial.
# Web Serial on this Chrome/CP210x combination reports BufferOverrunError on
# the ESP32 boot burst; .NET SerialPort does not.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\serial-bridge.ps1 [-ComPort COMx] [-Port 8771]

[CmdletBinding()]
param(
    [string]$ComPort,
    [int]$Port = 8771
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$logDir = Join-Path $root '.local'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'serial-bridge.log'

function Log([string]$message) {
    $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
    try { Add-Content -LiteralPath $logFile -Value $line -Encoding utf8 } catch {}
}

if (-not $ComPort) {
    $ports = Get-CimInstance Win32_SerialPort -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match 'CP210x|Silicon Labs' }
    if (-not $ports) { Log 'no CP210x serial port found'; throw 'No CP210x serial port found' }
    $ComPort = ($ports | Select-Object -First 1).DeviceID
}

Log "bridge starting: $ComPort on ws://127.0.0.1:$Port/serial"

$script:serial = $null
$script:serialDownLogged = $false

function Close-Serial {
    if ($script:serial) {
        try { $script:serial.Close() } catch {}
        try { $script:serial.Dispose() } catch {}
    }
    $script:serial = $null
}

# CP210x can drop its handle (USB suspend/re-enumeration). Keep the bridge
# alive and reopen instead of leaving every client with "端口被关闭".
function Open-Serial {
    if ($script:serial -and $script:serial.IsOpen) { return $true }
    Close-Serial
    try {
        $s = [System.IO.Ports.SerialPort]::new($ComPort, 115200, 'None', 8, 'One')
        $s.ReadBufferSize = 8192
        $s.ReadTimeout = 100
        $s.DtrEnable = $false
        $s.RtsEnable = $false
        $s.Open()
        $script:serial = $s
        if ($script:serialDownLogged) { Log "serial reopened: $ComPort" }
        $script:serialDownLogged = $false
        return $true
    } catch {
        if (-not $script:serialDownLogged) {
            Log "serial open failed: $($_.Exception.Message)"
            $script:serialDownLogged = $true
        }
        return $false
    }
}

if (-not (Open-Serial)) {
    Log 'serial unavailable; will retry when a client connects'
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Log "listening on 127.0.0.1:$Port"

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        try {
            if (-not $context.Request.IsWebSocketRequest -or $context.Request.Url.AbsolutePath -ne '/serial') {
                $bytes = [Text.Encoding]::UTF8.GetBytes('LT100 serial bridge')
                $context.Response.StatusCode = 200
                $context.Response.ContentType = 'text/plain; charset=utf-8'
                $context.Response.ContentLength64 = $bytes.Length
                $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
                $context.Response.Close()
                continue
            }

            # Block a random website from driving servos through this localhost
            # bridge; only the local console may open the socket.
            $origin = $context.Request.Headers['Origin']
            if ($origin -and $origin -notmatch '^https?://(127\.0\.0\.1|localhost)(:\d+)?$') {
                $context.Response.StatusCode = 403
                $context.Response.Close()
                continue
            }

            # PowerShell converts $null to "" for a [string] parameter; NullString
            # marshals as a real null subprotocol.
            $wsContext = $context.AcceptWebSocketAsync(
                [System.Management.Automation.Language.NullString]::Value
            ).GetAwaiter().GetResult()
            $ws = $wsContext.WebSocket
            Log 'client connected'
            $null = Open-Serial

            $buffer = New-Object byte[] 4096
            $segment = [ArraySegment[byte]]::new($buffer)
            $receive = $ws.ReceiveAsync($segment, [Threading.CancellationToken]::None)

            while ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
                $completed = [Threading.Tasks.Task]::WhenAny(
                    $receive,
                    [Threading.Tasks.Task]::Delay(20)
                ).GetAwaiter().GetResult()

                if ($completed -eq $receive) {
                    try {
                        $result = $receive.GetAwaiter().GetResult()
                    } catch {
                        Log "receive failed: $($_.Exception.Message)"
                        break
                    }
                    if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
                        try {
                            $ws.CloseAsync(
                                $result.CloseStatus,
                                $result.CloseStatusDescription,
                                [Threading.CancellationToken]::None
                            ).GetAwaiter().GetResult()
                        } catch {}
                        break
                    }
                    if ($result.Count -gt 0 -and $result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Text) {
                        $text = [Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
                        if ($script:serial -and $script:serial.IsOpen) {
                            try { $script:serial.Write($text) } catch {
                                Log "serial write failed: $($_.Exception.Message)"
                                Close-Serial
                            }
                        } else {
                            $null = Open-Serial
                        }
                    }
                    $receive = $ws.ReceiveAsync($segment, [Threading.CancellationToken]::None)
                    continue
                }

                if (-not ($script:serial -and $script:serial.IsOpen)) {
                    $null = Open-Serial
                    if (-not ($script:serial -and $script:serial.IsOpen)) {
                        Start-Sleep -Milliseconds 300
                        continue
                    }
                }
                try {
                    $data = $script:serial.ReadExisting()
                } catch {
                    Log "serial read failed: $($_.Exception.Message)"
                    Close-Serial
                    Start-Sleep -Milliseconds 300
                    continue
                }
                if ($data) {
                    $bytes = [Text.Encoding]::UTF8.GetBytes($data)
                    $sendSegment = [ArraySegment[byte]]::new($bytes)
                    try {
                        $ws.SendAsync(
                            $sendSegment,
                            [System.Net.WebSockets.WebSocketMessageType]::Text,
                            $true,
                            [Threading.CancellationToken]::None
                        ).GetAwaiter().GetResult()
                    } catch {
                        Log "websocket send failed: $($_.Exception.Message)"
                        break
                    }
                }
            }

            Log 'client disconnected'
            try { $ws.Dispose() } catch {}
        } catch {
            Log "client error: $($_.Exception.Message)"
            try { $context.Response.StatusCode = 400; $context.Response.Close() } catch {}
        }
    }
} finally {
    Close-Serial
    try { $listener.Stop() } catch {}
    try { $listener.Close() } catch {}
    Log 'bridge stopped'
}
