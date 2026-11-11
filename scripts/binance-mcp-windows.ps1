param([switch]$Configure)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$state = Join-Path $project '.wrangler/binance-mcp'
$settings = Join-Path $state 'windows-credentials.json'

if ($Configure) {
    $apiKey = Read-Host 'Binance Demo API Key' -AsSecureString
    $secret = Read-Host 'Binance Demo Secret Key' -AsSecureString
    try {
        if ($apiKey.Length -ne 64 -or $secret.Length -ne 64) {
            throw 'Expected a 64-character HMAC API Key and Secret Key.'
        }
        New-Item -ItemType Directory -Path $state -Force | Out-Null
        @{
            apiKey = ConvertFrom-SecureString -SecureString $apiKey
            secret = ConvertFrom-SecureString -SecureString $secret
        } | ConvertTo-Json | Set-Content -LiteralPath $settings -Encoding UTF8
        Write-Host 'Binance Demo credentials saved for the current Windows user.'
    } finally {
        $apiKey.Dispose()
        $secret.Dispose()
    }
    return
}

if (!(Test-Path -LiteralPath $settings)) {
    [Console]::Error.WriteLine('Run binance-mcp-windows.ps1 -Configure first.')
    exit 1
}

$stored = Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json
$apiKey = ConvertTo-SecureString $stored.apiKey
$secret = ConvertTo-SecureString $stored.secret
$names = @('BINANCE_DEMO_API_KEY', 'BINANCE_DEMO_SECRET_KEY', 'BINANCE_DEMO_PROXY')
$previous = @{}
foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name) }
try {
    $env:BINANCE_DEMO_API_KEY = [Net.NetworkCredential]::new('', $apiKey).Password
    $env:BINANCE_DEMO_SECRET_KEY = [Net.NetworkCredential]::new('', $secret).Password
    if (!$env:BINANCE_DEMO_PROXY) {
        $target = [uri]'https://demo-fapi.binance.com/fapi/v1/time'
        $proxy = [Net.WebRequest]::GetSystemWebProxy().GetProxy($target)
        if (!$proxy.IsLoopback -or $proxy.Scheme -notin @('http', 'https')) {
            throw 'A local HTTP system proxy was not found.'
        }
        $env:BINANCE_DEMO_PROXY = $proxy.AbsoluteUri
    }
    & node (Join-Path $PSScriptRoot 'binance-mcp-local.mjs')
    $status = $LASTEXITCODE
} finally {
    $apiKey.Dispose()
    $secret.Dispose()
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name]) }
}
exit $status
