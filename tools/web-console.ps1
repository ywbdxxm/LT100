# LT100 browser console launcher
# Serves LT100/ over http://127.0.0.1:<port>/ and opens web/<Page>.
# Web Serial requires a secure context, so localhost is intentional.
# With -Bridge, also starts the local WebSocket serial bridge (servo page).

[CmdletBinding()]
param(
    [int]$Port = 8773,
    [string]$Page = 'serial.html',
    [switch]$NoBrowser,
    [switch]$Bridge,
    [string]$ComPort
)

$ErrorActionPreference = 'Stop'
if ($Page -notmatch '^[A-Za-z0-9._-]+\.html$') { throw "Invalid page: $Page" }
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$rootPrefix = $root.TrimEnd('\') + '\'
$url = "http://127.0.0.1:$Port/web/$Page"

$contentTypes = @{
    '.html' = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.ico'  = 'image/x-icon'
    '.woff2' = 'font/woff2'
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$bridgeProc = $null

try {
    $listener.Start()
    if ($Bridge) {
        $bridgeScript = Join-Path $PSScriptRoot 'serial-bridge.ps1'
        $bridgeExe = (Get-Process -Id $PID).Path
        $bridgeArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$bridgeScript`"")
        if ($ComPort) { $bridgeArgs += @('-ComPort', $ComPort) }
        try {
            $bridgeProc = Start-Process -FilePath $bridgeExe -ArgumentList $bridgeArgs -PassThru -WindowStyle Hidden
            Write-Host 'Serial bridge: ws://127.0.0.1:8771/serial (auto-detect CP210x)' -ForegroundColor DarkGray
        } catch {
            Write-Host "Serial bridge failed to start: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
    Write-Host "LT100 web console: $url" -ForegroundColor Green
    Write-Host 'Keep this window open. Press Ctrl+C to stop.' -ForegroundColor DarkGray
    if (-not $NoBrowser) {
        try { Start-Process $url } catch { Write-Host "Open this URL manually: $url" -ForegroundColor Yellow }
    }

    while ($listener.IsListening) {
        $context = $listener.GetContext()
        try {
            $requestPath = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath.TrimStart('/'))
            if ([string]::IsNullOrWhiteSpace($requestPath)) { $requestPath = "web/$Page" }
            $fullPath = [System.IO.Path]::GetFullPath((Join-Path $root $requestPath))

            if (-not $fullPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                $context.Response.StatusCode = 403
                $context.Response.Close()
                continue
            }
            if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
                $bytes = [Text.Encoding]::UTF8.GetBytes('Not found')
                $context.Response.StatusCode = 404
                $context.Response.ContentType = 'text/plain; charset=utf-8'
                $context.Response.ContentLength64 = $bytes.Length
                $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
                $context.Response.Close()
                continue
            }

            $extension = [System.IO.Path]::GetExtension($fullPath).ToLowerInvariant()
            $contentType = $contentTypes[$extension]
            if (-not $contentType) { $contentType = 'application/octet-stream' }

            $bytes = [System.IO.File]::ReadAllBytes($fullPath)
            $context.Response.StatusCode = 200
            $context.Response.ContentType = $contentType
            $context.Response.Headers['Cache-Control'] = 'no-store'
            $context.Response.ContentLength64 = $bytes.Length
            $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
            $context.Response.Close()
        } catch {
            try {
                $context.Response.StatusCode = 500
                $context.Response.Close()
            } catch {}
        }
    }
} finally {
    if ($bridgeProc) { Stop-Process -Id $bridgeProc.Id -Force -ErrorAction SilentlyContinue }
    try { $listener.Stop() } catch {}
    try { $listener.Close() } catch {}
}
