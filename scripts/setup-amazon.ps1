$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$repo = '.runtime/amazon-scraper-bundled'
$archive = 'vendor/amazon-scraper-6697201.zip'
$expected = '768f3941a01b0c0db89e0dcb8577ca31f08d9a81e2089ace8d82c1f1d86daa10'
if (!(Test-Path $archive) -or (Get-FileHash $archive -Algorithm SHA256).Hash.ToLower() -ne $expected) { throw 'Bundled scraper missing or damaged. Extract the complete sharing package again.' }
Expand-Archive -LiteralPath $archive -DestinationPath $repo -Force
if (!(Test-Path '.runtime/omkar-venv/Scripts/python.exe')) {
  py -3.14 -m venv .runtime/omkar-venv
  if ($LASTEXITCODE) { throw 'Install Python 3.14 first.' }
}
& .runtime/omkar-venv/Scripts/python.exe -m pip install -r "$repo/requirements.txt"
if ($LASTEXITCODE) { throw 'Dependency installation failed.' }
& .runtime/omkar-venv/Scripts/python.exe scripts/test-amazon-local-api.py
if ($LASTEXITCODE) { throw 'Scraper verification failed.' }
Write-Output 'Ready. Select local scraper in the workbench. No separate API service is required.'
