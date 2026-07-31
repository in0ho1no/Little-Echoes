#!/bin/bash
# .github/workflows/security-scan.yml をローカルで再現する。
# WSL上のDockerで、CIと同じ固定バージョンイメージ(docker/semgrep, docker/gitleaks)を使う。
# Windowsからは docker/security-scan-local.ps1 経由で実行する。
set -u
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root" || exit 2
# /mnt/<drive>のrepoをrootで扱うとgitがdubious ownershipで失敗する。旧gitは
# -cのsafe.directoryを尊重しないため、一時globalコンフィグ経由で許可を渡す
git_config_tmp="$(mktemp)"
trap 'rm -f "$git_config_tmp" "$md_list_tmp"' EXIT
printf '[safe]\n\tdirectory = %s\n' "$repo_root" > "$git_config_tmp"
git_cmd() { GIT_CONFIG_GLOBAL="$git_config_tmp" git "$@"; }
md_list_tmp="$(mktemp)"
overall=0

echo "=== semgrep (CI: jobs.semgrep) ==="
docker build -q -t local-semgrep docker/semgrep/ >/dev/null || { echo "semgrep image build failed"; exit 2; }
exclude_args=()
while IFS= read -r -d '' md; do
  html="${md%.md}.html"
  [ -f "$html" ] && exclude_args+=(--exclude "$html")
done < <(find . -type f -name '*.md' -print0)
docker run --rm -v "$PWD:/src" -w /src local-semgrep \
  semgrep scan --config p/default --metrics=off --error --quiet "${exclude_args[@]}" --json --output semgrep-results.json . || true
if [ -f semgrep-results.json ]; then
  errors=$(python3 -c "import json; print(len(json.load(open('semgrep-results.json')).get('results', [])))")
  echo "semgrep findings: $errors"
  if [ "$errors" -gt 0 ]; then
    python3 -c "import json; [print(r['check_id'], r['path'], r['start']['line']) for r in json.load(open('semgrep-results.json'))['results']]"
    overall=1
  fi
else
  echo "semgrep-results.json not generated"
  overall=1
fi

echo "=== plaintext HTTP links in Markdown (CI: jobs.semgrep) ==="
# CIのcheckoutは追跡ファイルだけを含むため、ローカルはgit ls-filesで対象を揃え、
# node_modules等の未追跡ファイルによる偽陽性を避ける。ls-files自体の失敗は
# 「検出0件」と区別してFAILにする
if git_cmd ls-files -z -- '*.md' > "$md_list_tmp"; then
  md_count=$(tr -cd '\0' < "$md_list_tmp" | wc -c)
  matches=$(xargs -0 grep -InE 'http://[^[:space:])>"]+' < "$md_list_tmp" 2>/dev/null | grep -Ev 'http://(localhost|127\.0\.0\.1|\[::1\]|::1)([:/]|$)' || true)
  if [ -n "$matches" ]; then
    echo "Disallowed plaintext HTTP links found in Markdown:"
    echo "$matches"
    overall=1
  else
    echo "no plaintext http links (scanned $md_count tracked md files)"
  fi
else
  echo "git ls-files failed"
  overall=1
fi

echo "=== gitleaks (CI: jobs.gitleaks, full history) ==="
docker build -q -t local-gitleaks docker/gitleaks/ >/dev/null || { echo "gitleaks image build failed"; exit 2; }
if ! docker run --rm -v "$PWD:/repo" -w /repo \
  -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0=/repo \
  local-gitleaks detect --source . --no-banner --redact --report-format json --report-path gitleaks-results.json; then
  overall=1
fi

if [ "$overall" -eq 0 ]; then
  echo "RESULT: PASS (semgrep / http-link / gitleaks)"
else
  echo "RESULT: FAIL"
fi
exit "$overall"
