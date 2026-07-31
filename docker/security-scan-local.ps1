[CmdletBinding()]
param()

# CIのSecurity Scan(.github/workflows/security-scan.yml)をWSL上のDockerで再現する。
# 本体は同ディレクトリの security-scan-local.sh。push前の事前検証に使う。
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

if ($null -eq (Get-Command wsl -ErrorAction SilentlyContinue)) {
    throw 'WSLが見つかりません。ローカル再現にはWSL(Ubuntu)とWSL内のDockerが必要です。'
}

# Dockerデーモンは常駐していないことが多いため、停止時だけroot権限で起動する
wsl -u root -e sh -c 'docker info >/dev/null 2>&1 || service docker start' | Out-Null

$wslRepo = (wsl -e wslpath -a $repoRoot).Trim()
wsl -u root -e bash "$wslRepo/docker/security-scan-local.sh"
exit $LASTEXITCODE
