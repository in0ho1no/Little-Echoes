[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Command
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$toolsRoot = Join-Path $repositoryRoot '.tools'
$env:MISE_DATA_DIR = Join-Path $toolsRoot 'mise\data'
$env:MISE_CACHE_DIR = Join-Path $toolsRoot 'mise\cache'
$env:MISE_CONFIG_DIR = Join-Path $toolsRoot 'mise\config'
$env:MISE_STATE_DIR = Join-Path $toolsRoot 'mise\state'
$env:MISE_TMP_DIR = Join-Path $toolsRoot 'mise\tmp'
$env:PNPM_STORE_DIR = Join-Path $toolsRoot 'pnpm-store'
$env:NPM_CONFIG_CACHE = Join-Path $toolsRoot 'npm-cache'
$env:COREPACK_HOME = Join-Path $toolsRoot 'corepack'
$env:XDG_CONFIG_HOME = Join-Path $toolsRoot 'xdg-config'
$env:WRANGLER_SEND_METRICS = 'false'
$miseCommand = Get-Command mise -ErrorAction SilentlyContinue
$wingetMise = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\mise.exe'
if ($null -ne $miseCommand) {
    $mise = $miseCommand.Source
} elseif (Test-Path -LiteralPath $wingetMise) {
    $mise = $wingetMise
} else {
    throw 'mise が見つかりません。winget install jdx.mise を実行し、シェルを再起動してから再試行してください。'
}

if ($Command.Count -eq 0) {
    & $mise install
    exit $LASTEXITCODE
}

& $mise exec -- @Command
exit $LASTEXITCODE
