# Build and run the LT100 core host tests with MSVC.
# Usage: pwsh -NoProfile -File run-tests.ps1 [-BuildOnly]
param(
    [switch]$BuildOnly
)

$ErrorActionPreference = 'Stop'
$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) {
    throw "vcvars64.bat not found: $vcvars"
}

$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\libraries\lt100_core\src')).Path
$buildDir = Join-Path $PSScriptRoot 'build'
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

$sources = Get-ChildItem -Path (Join-Path $sourceRoot 'lt100') -Filter '*.cpp' |
    Sort-Object Name |
    ForEach-Object { $_.FullName }
$sources += (Join-Path $PSScriptRoot 'host_tests.cpp')

$arguments = @(
    '/nologo', '/std:c++17', '/EHsc', '/W4', '/utf-8',
    "/I`"$sourceRoot`"", "/I`"$PSScriptRoot`"",
    '/Fe:host_tests.exe'
) + ($sources | ForEach-Object { '"' + $_ + '"' })

Push-Location $buildDir
try {
    $vsInstaller = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer'
    if (Test-Path (Join-Path $vsInstaller 'vswhere.exe')) {
        $env:PATH = "$vsInstaller;$env:PATH"
    }
    $env:VSCMD_SKIP_SENDTELEMETRY = '1'
    $command = '"' + $vcvars + '" >nul && cl ' + ($arguments -join ' ')
    & cmd.exe /d /c $command
    if ($LASTEXITCODE -ne 0) {
        throw "compile failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

if (-not $BuildOnly) {
    & (Join-Path $buildDir 'host_tests.exe')
    if ($LASTEXITCODE -ne 0) {
        throw "tests failed with exit code $LASTEXITCODE"
    }
}
