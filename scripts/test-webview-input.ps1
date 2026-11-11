$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This desktop integration fixture requires Windows.' }
$txRoot = Split-Path -Parent $PSScriptRoot
Push-Location $txRoot
try {
    $txArtifacts = & cargo test --locked --manifest-path src-tauri/Cargo.toml --features webview-input-test --no-run --message-format=json
    if ($LASTEXITCODE -ne 0) { throw 'WebView input fixture compilation failed.' }
    $txExecutable = $txArtifacts | ForEach-Object {
        try {
            $txItem = $_ | ConvertFrom-Json
            if ($txItem.reason -eq 'compiler-artifact' -and $txItem.executable -and $txItem.target.name -eq 'nearcast_desktop_tx_lib') { $txItem.executable }
        } catch { }
    } | Select-Object -Last 1
    if (-not $txExecutable) { throw 'The compiled fixture was not found.' }
    $txSdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
    $txManifestTool = Get-ChildItem -LiteralPath $txSdk -Directory | Sort-Object Name -Descending | ForEach-Object {
        $txCandidate = Join-Path $_.FullName 'x64/mt.exe'
        if (Test-Path -LiteralPath $txCandidate) { $txCandidate }
    } | Select-Object -First 1
    if (-not $txManifestTool) { throw 'Install the Windows SDK manifest tool to run this fixture.' }
    $txManifest = Join-Path ([IO.Path]::GetTempPath()) ('nearcast-input-fixture-' + [guid]::NewGuid().ToString() + '.manifest')
    @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><assemblyIdentity version="1.0.0.0" processorArchitecture="amd64" name="NearCast.Input.Fixture" type="win32"/><dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="amd64" publicKeyToken="6595b64144ccf1df" language="*"/></dependentAssembly></dependency><trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>
'@ | Set-Content -LiteralPath $txManifest -Encoding utf8
    try {
        # Only the generated opt-in test binary needs this manifest. Application
        # builds already embed their Tauri manifest and are never modified here.
        & $txManifestTool '-nologo' '-manifest' $txManifest "-outputresource:$txExecutable;#1"
        if ($LASTEXITCODE -ne 0) { throw 'Unable to embed the fixture manifest.' }
        & $txExecutable own_webview_click_feedback_and_close_keep_the_ui_pumping --ignored --nocapture --test-threads=1
        if ($LASTEXITCODE -ne 0) { throw 'WebView input regression failed.' }
    } finally { Remove-Item -LiteralPath $txManifest }
} finally { Pop-Location }
