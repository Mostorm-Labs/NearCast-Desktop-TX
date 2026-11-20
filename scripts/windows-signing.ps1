[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string[]] $Path,
    [switch] $Check,
    [switch] $VerifyOnly
)

$ErrorActionPreference = 'Stop'
$toolRoot = $env:NEARCAST_WINDOWS_SIGNING_TOOL_DIR
if (-not $toolRoot -and $env:RUNNER_TEMP) {
    $toolRoot = [IO.Path]::GetFullPath((Join-Path $env:RUNNER_TEMP '..\..\signingtool'))
}
if (-not $toolRoot -or -not (Test-Path -LiteralPath $toolRoot -PathType Container)) {
    throw 'Signing directory is unavailable. Set the WINDOWS_SIGNING_TOOL_DIR Actions variable to the host signingtool directory.'
}

$toolFiles = 'AutoSign.bat', 'cer.cer', 'signtool.exe'
foreach ($name in $toolFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $toolRoot $name) -PathType Leaf)) {
        throw "Signing directory is missing $name."
    }
}
$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new((Join-Path $toolRoot 'cer.cer'))
if (-not $VerifyOnly -and ($certificate.NotBefore -gt [DateTime]::Now -or $certificate.NotAfter -le [DateTime]::Now)) {
    throw 'The Windows signing certificate is outside its validity period.'
}
if ($Check) {
    Write-Host "Windows signing files available. Certificate expires $($certificate.NotAfter.ToString('yyyy-MM-dd'))."
    return
}
if (-not $Path) { throw 'Pass at least one Windows executable or installer.' }

function Assert-Signature([string] $File) {
    $signature = Get-AuthenticodeSignature -LiteralPath $File
    if ($signature.Status -ne 'Valid' -or
        $signature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint -or
        -not $signature.TimeStamperCertificate) {
        throw "Authenticode verification failed for '$([IO.Path]::GetFileName($File))' ($($signature.Status)); expected the host certificate and a trusted timestamp."
    }
}

foreach ($inputPath in $Path) {
    $file = Get-Item -LiteralPath $inputPath
    $extension = $file.Extension
    # MakeNSIS passes the uninstaller PE image to !uninstfinalize as a .tmp file.
    if (-not $VerifyOnly -and $extension -eq '.tmp') { $extension = '.exe' }
    if ($file.PSIsContainer -or $extension -notin '.exe', '.dll', '.msi') {
        throw 'The Windows release signer accepts PE binaries and MSI files.'
    }
    if ($VerifyOnly) {
        Assert-Signature $file.FullName
    } else {
        $temp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
        $tempRoot = Get-Item -LiteralPath $temp
        $stagingPath = Join-Path $tempRoot.FullName ('nearcast-sign-' + [Guid]::NewGuid())
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        $runner = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $runner, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
        $staging = [IO.Directory]::CreateDirectory($stagingPath, $acl)
        if ($staging.Parent.FullName -ne $tempRoot.FullName) { throw 'Invalid Windows signing staging path.' }
        try {
            foreach ($name in $toolFiles) {
                Copy-Item -LiteralPath (Join-Path $toolRoot $name) -Destination $staging.FullName
            }
            $queue = New-Item -ItemType Directory -Path (Join-Path $staging.FullName 'all_files')
            $stagedFile = Join-Path $queue.FullName ('package' + $extension)
            Copy-Item -LiteralPath $file.FullName -Destination $stagedFile
            Push-Location -LiteralPath $staging.FullName
            try {
                # The batch file pauses and can contain token credentials. Close stdin and discard its output.
                & $env:ComSpec /d /c 'call AutoSign.bat <NUL >NUL 2>&1'
                if ($LASTEXITCODE -ne 0) { throw 'AutoSign failed. Check token access, the signing certificate, and timestamp connectivity on the runner.' }
            } finally {
                Pop-Location
            }
            Assert-Signature $stagedFile
            # Tauri can keep a read handle open on the main binary while the signing hook runs.
            $source = [IO.File]::OpenRead($stagedFile)
            try {
                $destination = [IO.File]::Open($file.FullName, 'Truncate', 'Write', 'ReadWrite')
                try {
                    $source.CopyTo($destination)
                } finally {
                    $destination.Dispose()
                }
            } finally {
                $source.Dispose()
            }
        } finally {
            Remove-Item -LiteralPath $staging.FullName -Recurse -Force
        }
    }
    Write-Host "Verified Authenticode signature and timestamp for $($file.Name)."
}
