param(
    [string]$SerializerManifest = $(if ($env:DX_SERIALIZER_MANIFEST) { $env:DX_SERIALIZER_MANIFEST } else { "G:\dx\serializer\Cargo.toml" }),
    [string]$SerializerExe = $(if ($env:DX_SERIALIZER_EXE) { $env:DX_SERIALIZER_EXE } else { "" }),
    [string]$SerializerEvidenceLock = $(if ($env:DX_SERIALIZER_EVIDENCE_LOCK) { $env:DX_SERIALIZER_EVIDENCE_LOCK } else { Join-Path $PSScriptRoot "dx-serializer-evidence-lock.json" }),
    [string]$OutputDir = ".dx\js",
    [string[]]$Inputs = @("package.json", "tsconfig.json", "tsconfig.base.json", "jsconfig.json", "bunfig.toml", "bunfig.node-test.toml"),
    [switch]$NoWorkspacePackages,
    [switch]$NoIndex,
    [int]$MaxWorkspacePackages = 128,
    [int]$MaxParallelSerializers = $(if ($env:DX_SERIALIZER_MAX_PARALLEL) { [int]$env:DX_SERIALIZER_MAX_PARALLEL } else { [System.Math]::Max(1, [System.Math]::Min([System.Environment]::ProcessorCount, 4)) }),
    [ValidateSet("none", "lz4", "zstd")]
    [string]$ColdLargeShardCompression = "none",
    [int64]$ColdLargeShardMinMachineBytes = 1048576,
    [string[]]$ColdLargeShardPatterns = @("structured/*"),
    [ValidateRange(0, 64)]
    [int]$ShardSourceHashPrefixLength = $(if ($env:DX_MACHINE_CACHE_SHARD_SOURCE_HASH_PREFIX_LENGTH) { [int]$env:DX_MACHINE_CACHE_SHARD_SOURCE_HASH_PREFIX_LENGTH } else { 0 }),
    [switch]$NoCompression,
    [switch]$ListInputsOnly
)

$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $true
}

function ConvertTo-DxSafeRepoRelativePathText {
    param(
        [string]$Value,
        [string]$Label,
        [switch]$AllowWildcards
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $null
    }

    $normalized = ([string]$Value).Trim()
    if ($normalized.Contains([char]0) -or
        $normalized.StartsWith("/") -or
        $normalized.StartsWith("\") -or
        $normalized.StartsWith("//") -or
        $normalized.StartsWith("\\") -or
        $normalized.Contains(":") -or
        [System.IO.Path]::IsPathRooted($normalized)) {
        throw "DX JS machine cache $Label must be repo-relative: $Value"
    }

    $normalized = ($normalized -replace "/", "\") -replace "^[.][\\/]", ""
    $parts = @($normalized -split "[\\/]+" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($parts.Count -eq 0) {
        return $null
    }

    foreach ($part in $parts) {
        if ($part -eq "." -or $part -eq ".." -or $part.Contains(":") -or $part.Contains([char]0)) {
            throw "DX JS machine cache $Label must stay inside the repo: $Value"
        }
        if ((-not $AllowWildcards) -and $part.Contains("*")) {
            throw "DX JS machine cache $Label cannot contain wildcards: $Value"
        }
    }

    return ($parts -join "\")
}

$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$safeOutputDir = ConvertTo-DxSafeRepoRelativePathText -Value $OutputDir -Label "output directory"
if ($null -eq $safeOutputDir) {
    throw "DX JS machine cache output directory must be repo-relative: $OutputDir"
}
$outputPath = Join-Path $repoRoot $safeOutputDir

function Get-DxSerializerExecutable {
    param([string]$ManifestPath)

    if (-not [string]::IsNullOrWhiteSpace($SerializerExe)) {
        return (Resolve-Path -LiteralPath $SerializerExe).Path
    }

    $buildOutput = @(
        cargo build `
            --locked `
            --manifest-path $ManifestPath `
            --bin dx-serialize `
            --features parallel `
            --message-format=json-render-diagnostics
    )

    if ($LASTEXITCODE -ne 0) {
        throw "dx-serialize build failed with exit code $LASTEXITCODE"
    }

    $executablePath = $null
    foreach ($line in $buildOutput) {
        if ([string]::IsNullOrWhiteSpace([string]$line)) {
            continue
        }

        try {
            $message = ([string]$line) | ConvertFrom-Json -ErrorAction Stop
        }
        catch {
            continue
        }

        if ($message.reason -eq "compiler-artifact" -and
            $message.target.name -eq "dx-serialize" -and
            -not [string]::IsNullOrWhiteSpace([string]$message.executable)) {
            $executablePath = [string]$message.executable
        }
    }

    if ([string]::IsNullOrWhiteSpace($executablePath)) {
        throw "Cargo did not report a built dx-serialize executable"
    }

    if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
        throw "Built dx-serialize executable does not exist: $executablePath"
    }

    return (Resolve-Path -LiteralPath $executablePath).Path
}

function ConvertTo-DxProcessArgument {
    param([string]$Argument)

    if ($null -eq $Argument -or $Argument.Length -eq 0) {
        return '""'
    }

    if ($Argument -notmatch '[\s"]') {
        return $Argument
    }

    $escaped = $Argument -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

function Join-DxProcessArguments {
    param([string[]]$Arguments)

    return (($Arguments | ForEach-Object { ConvertTo-DxProcessArgument $_ }) -join " ")
}

function Test-DxBatchFilePath {
    param([string]$ExecutablePath)

    $extension = [System.IO.Path]::GetExtension($ExecutablePath)
    return ($extension.Equals(".cmd", [System.StringComparison]::OrdinalIgnoreCase) -or
        $extension.Equals(".bat", [System.StringComparison]::OrdinalIgnoreCase))
}

function Assert-DxCmdArgumentsAreSafe {
    param([string[]]$Arguments)

    $cmdMetacharacters = @([char]'&', [char]'|', [char]'<', [char]'>', [char]'^', [char]'%', [char]'!', [char]13, [char]10)
    foreach ($argument in $Arguments) {
        if ($null -ne $argument -and ([string]$argument).IndexOfAny($cmdMetacharacters) -ge 0) {
            throw "DX serializer command argument contains cmd.exe metacharacters; refusing to execute via cmd.exe: $argument"
        }
    }
}

function Set-DxSerializerProcessCommand {
    param(
        [System.Diagnostics.ProcessStartInfo]$ProcessInfo,
        [string]$ExecutablePath,
        [string[]]$Arguments
    )

    if (Test-DxBatchFilePath -ExecutablePath $ExecutablePath) {
        $cmdArguments = @($ExecutablePath) + $Arguments
        Assert-DxCmdArgumentsAreSafe -Arguments $cmdArguments
        $ProcessInfo.FileName = $(if ([string]::IsNullOrWhiteSpace($env:ComSpec)) { "cmd.exe" } else { $env:ComSpec })
        $ProcessInfo.Arguments = "/d /c " + (Join-DxProcessArguments $cmdArguments)
    }
    else {
        $ProcessInfo.FileName = $ExecutablePath
        $ProcessInfo.Arguments = Join-DxProcessArguments $Arguments
    }
}

function Start-DxSerializerProcess {
    param(
        [string]$ExecutablePath,
        [string]$InputPath,
        [string]$CompressionFlag = "--no-compression"
    )

    $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $processInfo.WorkingDirectory = $repoRoot.Path
    $processInfo.UseShellExecute = $false
    $processInfo.RedirectStandardOutput = $true
    $processInfo.RedirectStandardError = $true

    $serializerArguments = @($InputPath, "--js-cache", "--machine-only", "--metadata", $CompressionFlag, "--output-dir", $outputPath)
    Set-DxSerializerProcessCommand -ProcessInfo $processInfo -ExecutablePath $ExecutablePath -Arguments $serializerArguments

    $process = [System.Diagnostics.Process]::Start($processInfo)
    return [pscustomobject]@{
        Input = $InputPath
        SourcePath = Join-Path $repoRoot $InputPath
        Process = $process
        Stdout = $process.StandardOutput.ReadToEndAsync()
        Stderr = $process.StandardError.ReadToEndAsync()
    }
}

function Start-DxSerializerInputsFileProcess {
    param(
        [string]$ExecutablePath,
        [string]$InputsFile,
        [string]$CompressionFlag = "--no-compression"
    )

    $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $processInfo.WorkingDirectory = $repoRoot.Path
    $processInfo.UseShellExecute = $false
    $processInfo.RedirectStandardOutput = $true
    $processInfo.RedirectStandardError = $true

    $serializerArguments = @("--inputs-file", $InputsFile, "--js-cache", "--machine-only", "--metadata", $CompressionFlag, "--output-dir", $outputPath)
    Set-DxSerializerProcessCommand -ProcessInfo $processInfo -ExecutablePath $ExecutablePath -Arguments $serializerArguments

    $process = [System.Diagnostics.Process]::Start($processInfo)
    return [pscustomobject]@{
        Input = $InputsFile
        SourcePath = $InputsFile
        Process = $process
        Stdout = $process.StandardOutput.ReadToEndAsync()
        Stderr = $process.StandardError.ReadToEndAsync()
    }
}

function Complete-DxSerializerProcess {
    param([object]$Job)

    $Job.Process.WaitForExit()
    $stdout = $Job.Stdout.Result
    $stderr = $Job.Stderr.Result

    if ($Job.Process.ExitCode -ne 0) {
        throw "dx-serialize failed for $($Job.SourcePath) with exit code $($Job.Process.ExitCode)`n$stderr$stdout"
    }
}

function Invoke-DxSerializerBatch {
    param(
        [string]$ExecutablePath,
        [System.Collections.Generic.List[string]]$InputPaths,
        [string]$CompressionFlag = "--no-compression"
    )

    $parallelLimit = [System.Math]::Max(1, $MaxParallelSerializers)
    if ($InputPaths.Count -gt 1) {
        $inputsFile = Join-Path $outputPath ("inputs." + [System.Guid]::NewGuid().ToString("N") + ".txt")
        try {
            $inputLines = foreach ($inputPath in $InputPaths) { [string]$inputPath }
            [System.IO.File]::WriteAllLines($inputsFile, [string[]]$inputLines, [System.Text.UTF8Encoding]::new($false))
            $job = Start-DxSerializerInputsFileProcess -ExecutablePath $ExecutablePath -InputsFile $inputsFile -CompressionFlag $CompressionFlag
            Complete-DxSerializerProcess -Job $job
        }
        finally {
            Remove-Item -LiteralPath $inputsFile -Force -ErrorAction SilentlyContinue
        }
        return
    }

    $pending = [System.Collections.Queue]::new()
    foreach ($inputPath in $InputPaths) {
        $pending.Enqueue($inputPath)
    }

    $running = [System.Collections.Generic.List[object]]::new()
    while ($pending.Count -gt 0 -or $running.Count -gt 0) {
        while ($pending.Count -gt 0 -and $running.Count -lt $parallelLimit) {
            $running.Add((Start-DxSerializerProcess -ExecutablePath $ExecutablePath -InputPath ([string]$pending.Dequeue()) -CompressionFlag $CompressionFlag))
        }

        $completedIndex = -1
        for ($index = 0; $index -lt $running.Count; $index++) {
            if ($running[$index].Process.HasExited) {
                $completedIndex = $index
                break
            }
        }

        if ($completedIndex -lt 0) {
            Start-Sleep -Milliseconds 25
            continue
        }

        $completedJob = $running[$completedIndex]
        $running.RemoveAt($completedIndex)
        Complete-DxSerializerProcess -Job $completedJob
    }
}

function Invoke-DxSerializer {
    param(
        [string]$ExecutablePath,
        [string]$InputPath,
        [string]$CompressionFlag
    )

    $job = Start-DxSerializerProcess -ExecutablePath $ExecutablePath -InputPath $InputPath -CompressionFlag $CompressionFlag
    Complete-DxSerializerProcess -Job $job
}

function Get-DxMachineCacheOutput {
    param(
        [string]$MachinePath,
        [string]$MetadataPath,
        [string]$SourcePath,
        [string]$SourceIndexPath
    )

    if (-not (Test-Path -LiteralPath $MachinePath -PathType Leaf)) {
        throw "Expected machine output was not created: $MachinePath"
    }
    if (-not (Test-Path -LiteralPath $MetadataPath -PathType Leaf)) {
        throw "Expected machine metadata output was not created: $MetadataPath"
    }

    $machineItem = Get-Item -LiteralPath $MachinePath
    $metadataItem = Get-Item -LiteralPath $MetadataPath
    $metadataJson = Get-Content -LiteralPath $MetadataPath -Raw | ConvertFrom-Json
    if ($metadataJson.schema -ne "dx.machine.source_metadata.v1") {
        throw "Expected machine metadata schema dx.machine.source_metadata.v1 in $MetadataPath"
    }
    if ($null -eq $metadataJson.source -or $null -eq $metadataJson.machine) {
        throw "Expected machine metadata source and machine sections in $MetadataPath"
    }

    $sourceItem = Get-Item -LiteralPath $SourcePath
    if ($null -eq $metadataJson.source.bytes -or [int64]$metadataJson.source.bytes -ne [int64]$sourceItem.Length) {
        throw "Expected source byte count $($sourceItem.Length) in machine metadata for $SourceIndexPath"
    }
    if ($null -eq $metadataJson.machine.bytes -or [int64]$metadataJson.machine.bytes -ne [int64]$machineItem.Length) {
        throw "Expected machine byte count $($machineItem.Length) in machine metadata for $MachinePath"
    }

    $sourceHash = [string]$metadataJson.source.blake3
    $machineHash = [string]$metadataJson.machine.blake3
    if ($sourceHash -notmatch "^[0-9a-f]{64}$") {
        throw "Expected lowercase 64-hex source blake3 in machine metadata for $SourceIndexPath"
    }
    if ($machineHash -notmatch "^[0-9a-f]{64}$") {
        throw "Expected lowercase 64-hex machine blake3 in machine metadata for $MachinePath"
    }

    if (-not [string]::IsNullOrWhiteSpace([string]$metadataJson.source.path)) {
        $metadataSourcePath = ConvertTo-IndexPath ([string]$metadataJson.source.path)
        if ($metadataSourcePath -ne (ConvertTo-IndexPath $SourceIndexPath)) {
            throw "Expected source path $SourceIndexPath in machine metadata, got $metadataSourcePath"
        }
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$metadataJson.machine.path)) {
        $metadataMachineLeaf = Split-Path -Leaf ([string]$metadataJson.machine.path)
        if ($metadataMachineLeaf -ne (Split-Path -Leaf $MachinePath)) {
            throw "Expected machine path $(Split-Path -Leaf $MachinePath) in machine metadata, got $metadataMachineLeaf"
        }
    }

    return [pscustomobject]@{
        MachineItem = $machineItem
        MetadataItem = $metadataItem
        MetadataJson = $metadataJson
    }
}

function ConvertTo-RepoRelativePath {
    param([string]$Path)

    $rootText = [System.IO.Path]::GetFullPath($repoRoot.Path).TrimEnd("\", "/")
    $rootWithSeparator = $rootText + [System.IO.Path]::DirectorySeparatorChar
    $fullText = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path)

    if ($fullText.Equals($rootText, [System.StringComparison]::OrdinalIgnoreCase)) {
        return ""
    }

    if ($fullText.StartsWith($rootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)) {
        return ($fullText.Substring($rootText.Length).TrimStart("\", "/") -replace "\\", "/")
    }

    throw "DX JS machine cache path escaped repo root: $Path"
}

function ConvertTo-IndexPath {
    param([string]$Path)

    return (($Path -replace "^[.][\\/]", "") -replace "\\", "/")
}

function ConvertTo-DxCacheStemPart {
    param([string]$Value)

    $builder = [System.Text.StringBuilder]::new()
    $previousWasDash = $false

    foreach ($char in $Value.ToCharArray()) {
        $code = [int][char]$char
        $isAlphaNumeric = ($code -ge 48 -and $code -le 57) -or ($code -ge 65 -and $code -le 90) -or ($code -ge 97 -and $code -le 122)

        if ($isAlphaNumeric -or $char -eq "_") {
            [void]$builder.Append($char)
            $previousWasDash = $false
        }
        elseif (-not $previousWasDash) {
            [void]$builder.Append("-")
            $previousWasDash = $true
        }
    }

    $trimmed = $builder.ToString().Trim("-")
    if ([string]::IsNullOrWhiteSpace($trimmed)) {
        return "path"
    }

    return $trimmed
}

function Get-DxCacheStem {
    param([string]$RelativePath)

    $normalized = $RelativePath -replace "/", "\"
    $parts = @($normalized -split "[\\/]+" | Where-Object { $_ -and $_ -ne "." })
    $isStructured = $normalized.EndsWith(".json", [System.StringComparison]::OrdinalIgnoreCase) -or $normalized.EndsWith(".toml", [System.StringComparison]::OrdinalIgnoreCase)

    if ($isStructured -and $parts.Count -gt 1) {
        return (($parts | ForEach-Object { ConvertTo-DxCacheStemPart $_ }) -join "-")
    }

    $fileName = Split-Path -Leaf $normalized
    if ($isStructured) {
        return ConvertTo-DxCacheStemPart $fileName
    }

    return ConvertTo-DxCacheStemPart ([System.IO.Path]::GetFileNameWithoutExtension($fileName))
}

function Get-DxCacheKind {
    param([string]$RelativePath)

    $normalized = ConvertTo-IndexPath $RelativePath
    $leaf = Split-Path -Leaf $normalized

    if ($leaf.Equals("package.json", [System.StringComparison]::OrdinalIgnoreCase)) {
        return "package_json"
    }

    if (($leaf.Equals("bunfig.toml", [System.StringComparison]::OrdinalIgnoreCase) -or
            ($leaf.StartsWith("bunfig.", [System.StringComparison]::OrdinalIgnoreCase) -and
            $leaf.EndsWith(".toml", [System.StringComparison]::OrdinalIgnoreCase)))) {
        return "bunfig"
    }

    if ($leaf.StartsWith("tsconfig", [System.StringComparison]::OrdinalIgnoreCase) -or
        $leaf.StartsWith("jsconfig", [System.StringComparison]::OrdinalIgnoreCase)) {
        return "tsconfig"
    }

    return "structured"
}

function Test-DxTrustedCatalogKind {
    param([string]$Kind)

    return $Kind -in @("package_json", "tsconfig", "bunfig")
}

function Assert-DxUniqueCacheStems {
    param([System.Collections.Generic.List[string]]$InputPaths)

    $seenStems = [System.Collections.Generic.Dictionary[string, string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($inputPath in $InputPaths) {
        $stem = Get-DxCacheStem $inputPath
        if ($seenStems.ContainsKey($stem)) {
            throw "Duplicate DX JS machine cache stem '$stem' for inputs '$($seenStems[$stem])' and '$inputPath'"
        }
        $seenStems[$stem] = $inputPath
    }
}

function Get-DxMachineCacheCompressionFlag {
    param([string]$Compression)

    switch ($Compression) {
        "lz4" { return "--lz4" }
        "zstd" { return "--zstd" }
        default { return "--no-compression" }
    }
}

function Test-DxShardPattern {
    param(
        [string]$Shard,
        [string[]]$Patterns
    )

    foreach ($pattern in $Patterns) {
        if ([string]::IsNullOrWhiteSpace($pattern)) {
            continue
        }

        $wildcard = [System.Management.Automation.WildcardPattern]::new(
            $pattern,
            [System.Management.Automation.WildcardOptions]::IgnoreCase
        )
        if ($wildcard.IsMatch($Shard)) {
            return $true
        }
    }

    return $false
}

function Test-DxColdLargeShard {
    param(
        [string]$Kind,
        [string]$Shard,
        [int64]$MachineBytes
    )

    if ($NoCompression) {
        return $false
    }

    if ($ColdLargeShardCompression -eq "none") {
        return $false
    }

    if ($Kind -in @("package_json", "tsconfig", "bunfig")) {
        return $false
    }

    if ($MachineBytes -lt $ColdLargeShardMinMachineBytes) {
        return $false
    }

    return Test-DxShardPattern -Shard $Shard -Patterns $ColdLargeShardPatterns
}

function ConvertTo-DxLowerHex {
    param([byte[]]$Bytes)

    $builder = [System.Text.StringBuilder]::new($Bytes.Length * 2)
    foreach ($byte in $Bytes) {
        [void]$builder.Append($byte.ToString("x2"))
    }
    return $builder.ToString()
}

function Get-DxFileSha256Hex {
    param([string]$Path)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        return ConvertTo-DxLowerHex -Bytes ($sha.ComputeHash($stream))
    }
    finally {
        $stream.Dispose()
        $sha.Dispose()
    }
}

function Test-DxSerializerEvidenceWaived {
    $value = [string]$env:DX_SERIALIZER_EVIDENCE_ALLOW_UNPINNED
    return $value -eq "1" -or $value.Equals("true", [System.StringComparison]::OrdinalIgnoreCase)
}

function New-DxSerializerEvidenceWaiver {
    param(
        [string]$Scope,
        [bool]$ExecutableOverride
    )

    return [pscustomobject][ordered]@{
        schema = "dx.serializer.evidence_lock.verification.v1"
        waived = $true
        reason = "DX_SERIALIZER_EVIDENCE_ALLOW_UNPINNED"
        scope = $Scope
        executableOverride = $ExecutableOverride
        completeSourceCoverage = $false
        fileCount = 0
    }
}

function Assert-DxSerializerEvidencePathHasNoReparsePoint {
    param(
        [string]$SerializerRoot,
        [string]$RelativePath,
        [string]$DisplayPath
    )

    $current = $SerializerRoot
    $parts = @($RelativePath -split "[\\/]+" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    foreach ($part in $parts) {
        $current = Join-Path $current $part
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "DX serializer evidence path crosses a reparse point: $DisplayPath"
            }
        }
    }
}

function Get-DxSerializerEvidenceLock {
    param(
        [string]$ManifestPath,
        [AllowNull()][string]$ExecutableOverride
    )

    $waived = Test-DxSerializerEvidenceWaived
    $hasExecutableOverride = -not [string]::IsNullOrWhiteSpace($ExecutableOverride)
    if ($hasExecutableOverride) {
        if (-not $waived) {
            throw "DX serializer executable override is unpinned. Set DX_SERIALIZER_EVIDENCE_ALLOW_UNPINNED=1 only for local/test runs."
        }
        return New-DxSerializerEvidenceWaiver -Scope "unverified-executable-override" -ExecutableOverride $true
    }

    if ([string]::IsNullOrWhiteSpace($SerializerEvidenceLock) -or -not (Test-Path -LiteralPath $SerializerEvidenceLock -PathType Leaf)) {
        if ($waived) {
            return New-DxSerializerEvidenceWaiver -Scope "missing-lock-waiver" -ExecutableOverride $false
        }
        throw "DX serializer evidence lock is missing: $SerializerEvidenceLock"
    }

    $lockPath = Resolve-Path -LiteralPath $SerializerEvidenceLock
    $lock = Get-Content -LiteralPath $lockPath.Path -Raw | ConvertFrom-Json
    if ([string]$lock.schema -ne "dx.serializer.external_evidence_lock.v1") {
        throw "DX serializer evidence lock schema mismatch: $($lock.schema)"
    }

    $serializerRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent ([System.IO.Path]::GetFullPath($ManifestPath))))
    $serializerRootPrefix = $serializerRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    $files = @($lock.files)
    if ($files.Count -eq 0) {
        throw "DX serializer evidence lock has no pinned files"
    }

    foreach ($file in $files) {
        $relative = ConvertTo-DxSafeRepoRelativePathText -Value ([string]$file.path) -Label "serializer evidence path"
        if ($null -eq $relative) {
            throw "DX serializer evidence lock contains an empty path"
        }
        $fullPath = [System.IO.Path]::GetFullPath((Join-Path $serializerRoot $relative))
        if (-not $fullPath.StartsWith($serializerRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "DX serializer evidence path escapes serializer root: $($file.path)"
        }
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            throw "DX serializer evidence file is missing: $($file.path)"
        }
        Assert-DxSerializerEvidencePathHasNoReparsePoint -SerializerRoot $serializerRoot -RelativePath $relative -DisplayPath ([string]$file.path)

        $item = Get-Item -LiteralPath $fullPath
        $expectedBytes = [int64]$file.bytes
        $expectedSha256 = ([string]$file.sha256).ToLowerInvariant()
        $actualSha256 = Get-DxFileSha256Hex -Path $fullPath
        if ($item.Length -ne $expectedBytes -or $actualSha256 -ne $expectedSha256) {
            throw "DX serializer evidence drift for $($file.path): expected bytes=$expectedBytes sha256=$expectedSha256 actual bytes=$($item.Length) sha256=$actualSha256"
        }
    }

    return [pscustomobject][ordered]@{
        schema = "dx.serializer.evidence_lock.verification.v1"
        path = $lockPath.Path
        sha256 = Get-DxFileSha256Hex -Path $lockPath.Path
        serializerRoot = $serializerRoot
        scope = "declared-files-only"
        completeSourceCoverage = $false
        fileCount = $files.Count
    }
}

function Get-DxMachineCacheShardContentId {
    param([object[]]$Entries)

    $builder = [System.Text.StringBuilder]::new()
    foreach ($entry in ($Entries | Sort-Object { [string]$_["key"] })) {
        [void]$builder.Append([string]$entry["key"])
        [void]$builder.Append([char]0)
        [void]$builder.Append([string]$entry["sourceBlake3"])
        [void]$builder.Append([char]0)
        [void]$builder.Append([string]$entry["machineBlake3"])
        [void]$builder.Append([char]0)
    }

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($builder.ToString())
        return (ConvertTo-DxLowerHex -Bytes ($sha.ComputeHash($bytes))).Substring(0, 16)
    }
    finally {
        $sha.Dispose()
    }
}

function New-DxMachineCacheCatalog {
    param(
        [object[]]$Entries,
        [string]$GeneratedAtUtc,
        [ValidateRange(0, 64)]
        [int]$ShardSourceHashPrefixLength = 0
    )

    $seenKeys = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $seenShards = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $catalogEntries = @()

    foreach ($entry in ($Entries | Sort-Object source, kind)) {
        if ([string]::IsNullOrWhiteSpace($entry.sourceBlake3)) {
            throw "DX JS machine cache catalog entry is missing source hash: $($entry.source)"
        }

        $sourceHashPrefix = $entry.sourceBlake3.Substring(0, [System.Math]::Min($ShardSourceHashPrefixLength, $entry.sourceBlake3.Length)).ToLowerInvariant()
        if ($sourceHashPrefix.Length -lt $ShardSourceHashPrefixLength) {
            throw "DX JS machine cache catalog entry source hash is too short: $($entry.source)"
        }

        $key = $entry.kind + [string][char]0 + $entry.source
        if (-not $seenKeys.Add($key)) {
            throw "Duplicate DX JS machine cache catalog key: $key"
        }

        $shard = if ($ShardSourceHashPrefixLength -eq 0) {
            $entry.kind
        } else {
            $entry.kind + "/" + $sourceHashPrefix
        }
        $catalogEntry = [ordered]@{
            key = $key
            kind = $entry.kind
            source = $entry.source
            shard = $shard
            machine = $entry.machine
            metadata = $entry.metadata
            sourceBytes = $entry.sourceBytes
            sourceModifiedUnixMs = $entry.sourceModifiedUnixMs
            sourceBlake3 = $entry.sourceBlake3
            machineBlake3 = $entry.machineBlake3
            machineBytes = $entry.machineBytes
            metadataBytes = $entry.metadataBytes
        }
        if ($entry.Contains("keyInterning")) {
            $catalogEntry["keyInterning"] = $entry.keyInterning
        }
        $catalogEntries += $catalogEntry
    }

    foreach ($group in ($catalogEntries | Group-Object { [string]$_["shard"] })) {
        $contentId = Get-DxMachineCacheShardContentId -Entries @($group.Group)
        $immutableShard = $group.Name + "/" + $contentId
        [void]$seenShards.Add($immutableShard)
        foreach ($entry in $group.Group) {
            $entry["shard"] = $immutableShard
        }
    }

    return [ordered]@{
        schema = "dx.js.machine_cache_catalog.v1"
        generatedAtUtc = $GeneratedAtUtc
        shards = @($seenShards | Sort-Object)
        entries = @($catalogEntries | Sort-Object { ([string]$_["key"]) -replace ([string][char]0), "!" })
    }
}

function New-DxSerializerIdentity {
    param(
        [string]$ManifestPath,
        [AllowNull()][string]$ExecutablePath,
        [AllowNull()][object]$EvidenceLock
    )

    $identity = [ordered]@{
        schema = "dx.js.machine_cache_serializer.v1"
        manifest = [System.IO.Path]::GetFullPath($ManifestPath)
        executable = $ExecutablePath
        bin = "dx-serialize"
        cargoArgs = @("build", "--locked", "--manifest-path", $ManifestPath, "--bin", "dx-serialize", "--features", "parallel")
        runtimeArgs = @("--js-cache", "--machine-only", "--metadata", "--write-js-cache-artifacts")
    }
    if ($null -ne $EvidenceLock) {
        $identity["evidenceLock"] = [pscustomobject]$EvidenceLock
    }
    return $identity
}

function Add-DxPackageJsonObjectKeys {
    param(
        [object]$Value,
        [System.Collections.Generic.Dictionary[string, int]]$Counts
    )

    if ($null -eq $Value) {
        return
    }

    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        foreach ($property in $Value.PSObject.Properties) {
            $key = [string]$property.Name
            if ($Counts.ContainsKey($key)) {
                $Counts[$key] += 1
            }
            else {
                $Counts[$key] = 1
            }
            Add-DxPackageJsonObjectKeys -Value $property.Value -Counts $Counts
        }
        return
    }

    if ($Value -is [System.Collections.IDictionary]) {
        foreach ($keyObject in $Value.Keys) {
            $key = [string]$keyObject
            if ($Counts.ContainsKey($key)) {
                $Counts[$key] += 1
            }
            else {
                $Counts[$key] = 1
            }
            Add-DxPackageJsonObjectKeys -Value $Value[$keyObject] -Counts $Counts
        }
        return
    }

    if (($Value -is [System.Collections.IEnumerable]) -and -not ($Value -is [string])) {
        foreach ($item in $Value) {
            Add-DxPackageJsonObjectKeys -Value $item -Counts $Counts
        }
    }
}

function Add-DxPackageJsonObjectKeysFromText {
    param(
        [string]$Text,
        [System.Collections.Generic.Dictionary[string, int]]$Counts
    )

    for ($index = 0; $index -lt $Text.Length; $index++) {
        if ($Text[$index] -ne '"') {
            continue
        }

        $cursor = $index + 1
        $escaped = $false
        while ($cursor -lt $Text.Length) {
            $char = $Text[$cursor]
            if ($escaped) {
                $escaped = $false
            }
            elseif ($char -eq '\') {
                $escaped = $true
            }
            elseif ($char -eq '"') {
                break
            }
            $cursor += 1
        }

        if ($cursor -ge $Text.Length) {
            break
        }

        $afterString = $cursor + 1
        while ($afterString -lt $Text.Length -and [char]::IsWhiteSpace($Text[$afterString])) {
            $afterString += 1
        }

        if ($afterString -ge $Text.Length -or $Text[$afterString] -ne ':') {
            $index = $cursor
            continue
        }

        $literal = $Text.Substring($index, $cursor - $index + 1)
        $key = [string]($literal | ConvertFrom-Json)
        if ($Counts.ContainsKey($key)) {
            $Counts[$key] += 1
        }
        else {
            $Counts[$key] = 1
        }

        $index = $cursor
    }
}

function New-DxPackageJsonKeyInterningSidecar {
    param([string]$Text)

    $counts = [System.Collections.Generic.Dictionary[string, int]]::new([System.StringComparer]::Ordinal)
    Add-DxPackageJsonObjectKeysFromText -Text $Text -Counts $counts

    $sortedKeys = [string[]]$counts.Keys
    [System.Array]::Sort($sortedKeys, [System.StringComparer]::Ordinal)

    $keys = @()
    $objectKeyOccurrences = 0
    $repeatedKeys = 0
    $repeatedKeyOccurrences = 0
    $extraRepeatedKeyOccurrences = 0
    $originalQuotedKeyBytes = 0
    $internedUniqueQuotedKeyBytes = 0
    $savedQuotedKeyBytes = 0

    foreach ($key in $sortedKeys) {
        $occurrences = [int]$counts[$key]
        $keyUtf8Bytes = (ConvertTo-DxUtf8Bytes $key).Length
        $quotedKeyBytes = (ConvertTo-DxUtf8Bytes (($key | ConvertTo-Json -Compress) + ":")).Length
        $extraOccurrences = [System.Math]::Max(0, $occurrences - 1)
        $estimatedSavedQuotedKeyBytes = $extraOccurrences * $quotedKeyBytes

        $objectKeyOccurrences += $occurrences
        $originalQuotedKeyBytes += $occurrences * $quotedKeyBytes
        $internedUniqueQuotedKeyBytes += $quotedKeyBytes
        $savedQuotedKeyBytes += $estimatedSavedQuotedKeyBytes

        if ($occurrences -gt 1) {
            $repeatedKeys += 1
            $repeatedKeyOccurrences += $occurrences
            $extraRepeatedKeyOccurrences += $extraOccurrences
        }

        $keys += [ordered]@{
            key = $key
            occurrences = $occurrences
            extraOccurrences = $extraOccurrences
            keyUtf8Bytes = $keyUtf8Bytes
            quotedKeyBytes = $quotedKeyBytes
            estimatedSavedQuotedKeyBytes = $estimatedSavedQuotedKeyBytes
        }
    }

    return [ordered]@{
        schema = "dx.package_json.key_interning_sidecar.v1"
        sourceFormat = "package_json"
        keyEncoding = "utf8"
        objectKeyOccurrences = $objectKeyOccurrences
        uniqueKeys = $keys.Count
        repeatedKeys = $repeatedKeys
        repeatedKeyOccurrences = $repeatedKeyOccurrences
        extraRepeatedKeyOccurrences = $extraRepeatedKeyOccurrences
        estimated = [ordered]@{
            originalQuotedKeyBytes = $originalQuotedKeyBytes
            internedUniqueQuotedKeyBytes = $internedUniqueQuotedKeyBytes
            savedQuotedKeyBytes = $savedQuotedKeyBytes
        }
        keys = $keys
    }
}

function Write-DxPackageJsonKeyInterningSidecar {
    param(
        [string]$SourcePath,
        [string]$Path
    )

    $tempPath = $Path + "." + [System.Guid]::NewGuid().ToString("N") + ".tmp"
    $payload = New-DxPackageJsonKeyInterningSidecar -Text ([System.IO.File]::ReadAllText($SourcePath, [System.Text.UTF8Encoding]::new($false)))
    $json = ($payload | ConvertTo-Json -Depth 8) + [System.Environment]::NewLine
    [System.IO.File]::WriteAllText($tempPath, $json, [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tempPath -Destination $Path -Force
    return Get-Item -LiteralPath $Path
}

function Write-DxPackageJsonReadTrustMarker {
    param(
        [string]$Path,
        [string]$GeneratedAtUtc
    )

    $tempPath = $Path + "." + [System.Guid]::NewGuid().ToString("N") + ".tmp"
    $payload = [ordered]@{
        schema = "dx.js.machine_cache_package_json_read_trust.v1"
        generatedAtUtc = $GeneratedAtUtc
        catalogMachine = "catalog.machine"
        packageJsonRead = "trusted_resolver_snapshot"
    }
    $json = ($payload | ConvertTo-Json -Depth 4) + [System.Environment]::NewLine
    [System.IO.File]::WriteAllText($tempPath, $json, [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tempPath -Destination $Path -Force
    return Get-Item -LiteralPath $Path
}

function ConvertTo-DxUtf8Bytes {
    param([string]$Value)

    return [System.Text.UTF8Encoding]::new($false).GetBytes($Value)
}

function Get-DxPackedShardFilePaths {
    param(
        [object]$Catalog,
        [string]$ShardRoot
    )

    $paths = @()
    foreach ($shard in @($Catalog.shards)) {
        $entries = @($Catalog.entries | Where-Object { $_.shard -eq $shard })
        if ($entries.Count -eq 0) {
            continue
        }
        $paths += Join-Path $ShardRoot (($shard -replace "/", "\") + ".dxjs")
    }
    return $paths
}

function Invoke-DxSerializerCacheArtifacts {
    param(
        [AllowNull()][string]$ExecutablePath,
        [object]$Catalog,
        [string]$CatalogJson,
        [string]$CatalogJsonPath,
        [string]$OutputPath,
        [string]$CatalogMachinePath,
        [string]$ShardRoot,
        [string]$ShardPathIdentityRoot
    )

    if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
        throw "dx-serialize executable is required to write rkyv JS cache artifacts"
    }

    $stagingOutputPath = Join-Path $OutputPath (".artifacts." + [System.Guid]::NewGuid().ToString("N") + ".tmp")
    $stagedCatalogMachinePath = Join-Path $stagingOutputPath "catalog.machine"
    $stagedShardRoot = Join-Path $stagingOutputPath "shards"

    New-Item -ItemType Directory -Force -Path $stagingOutputPath | Out-Null
    try {
        $artifactArguments = @(
            "--write-js-cache-artifacts",
            "--catalog-json",
            $CatalogJsonPath,
            "--output-dir",
            $stagingOutputPath,
            "--js-cache-shard-root",
            $ShardPathIdentityRoot
        )

        $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $processInfo.WorkingDirectory = $repoRoot.Path
        $processInfo.UseShellExecute = $false
        $processInfo.RedirectStandardOutput = $true
        $processInfo.RedirectStandardError = $true
        Set-DxSerializerProcessCommand -ProcessInfo $processInfo -ExecutablePath $ExecutablePath -Arguments $artifactArguments

        $process = [System.Diagnostics.Process]::Start($processInfo)
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()

        if ($process.ExitCode -ne 0) {
            throw "dx-serialize failed while writing JS cache artifacts with exit code $($process.ExitCode)`n$stderr$stdout"
        }

        $stagedArtifactPaths = @($stagedCatalogMachinePath) + @(Get-DxPackedShardFilePaths -Catalog $Catalog -ShardRoot $stagedShardRoot)
        foreach ($artifactPath in $stagedArtifactPaths) {
            if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
                throw "Expected DX JS cache artifact was not created: $artifactPath"
            }
        }

        $finalShardPaths = @(Get-DxPackedShardFilePaths -Catalog $Catalog -ShardRoot $ShardRoot)
        $stagedShardPaths = @(Get-DxPackedShardFilePaths -Catalog $Catalog -ShardRoot $stagedShardRoot)
        if ($finalShardPaths.Count -ne $stagedShardPaths.Count) {
            throw "DX JS cache staged shard count mismatch: staged=$($stagedShardPaths.Count) final=$($finalShardPaths.Count)"
        }
        for ($i = 0; $i -lt $finalShardPaths.Count; $i++) {
            $finalShardPath = $finalShardPaths[$i]
            $stagedShardPath = $stagedShardPaths[$i]
            if (-not (Test-Path -LiteralPath $stagedShardPath -PathType Leaf)) {
                throw "Expected staged DX JS cache shard disappeared before publish: $stagedShardPath"
            }
            $finalShardDir = Split-Path -Parent $finalShardPath
            New-Item -ItemType Directory -Force -Path $finalShardDir | Out-Null
            $finalTempPath = $finalShardPath + ".publish." + [System.Guid]::NewGuid().ToString("N") + ".tmp"
            Copy-Item -LiteralPath $stagedShardPath -Destination $finalTempPath -Force
            Move-Item -LiteralPath $finalTempPath -Destination $finalShardPath -Force
        }

        $catalogMachineDir = Split-Path -Parent $CatalogMachinePath
        New-Item -ItemType Directory -Force -Path $catalogMachineDir | Out-Null
        $catalogMachineTempPath = $CatalogMachinePath + ".publish." + [System.Guid]::NewGuid().ToString("N") + ".tmp"
        Copy-Item -LiteralPath $stagedCatalogMachinePath -Destination $catalogMachineTempPath -Force
        Move-Item -LiteralPath $catalogMachineTempPath -Destination $CatalogMachinePath -Force
        return @($CatalogMachinePath) + $finalShardPaths
    }
    finally {
        Remove-Item -LiteralPath $stagingOutputPath -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$inputList = [System.Collections.Generic.List[string]]::new()
$seenInputs = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

function Add-DxInput {
    param([string]$RelativePath)

    $normalized = ConvertTo-DxSafeRepoRelativePathText -Value $RelativePath -Label "input"
    if ($null -eq $normalized) {
        return
    }

    if ($seenInputs.Add($normalized)) {
        [void]$inputList.Add($normalized)
    }
}

function Add-DxWorkspacePackageInputs {
    param([string]$WorkspacePattern)

    $workspacePath = ConvertTo-DxSafeRepoRelativePathText -Value $WorkspacePattern -Label "workspace pattern" -AllowWildcards
    if ($null -eq $workspacePath) {
        return
    }

    if (-not $workspacePath.Contains("*")) {
        Add-DxInput (Join-Path $workspacePath "package.json")
        return
    }

    if ($workspacePath.Contains("**")) {
        Write-Warning "Skipping recursive workspace pattern '$workspacePath' for bounded DX cache generation"
        return
    }

    $matches = @(Get-ChildItem -Path (Join-Path $repoRoot $workspacePath) -Directory -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -notin @(".git", "node_modules", "CMakeFiles") -and
            (Test-Path -LiteralPath (Join-Path $_.FullName "package.json") -PathType Leaf)
        } |
        Sort-Object FullName |
        Select-Object -First $MaxWorkspacePackages)

    foreach ($match in $matches) {
        $relativeWorkspacePath = ConvertTo-RepoRelativePath $match.FullName
        Add-DxInput (Join-Path $relativeWorkspacePath "package.json")
    }
}

foreach ($input in $Inputs) {
    foreach ($inputPart in ([string]$input -split ",")) {
        Add-DxInput $inputPart.Trim()
    }
}

if (-not $NoWorkspacePackages) {
    $rootPackagePath = Join-Path $repoRoot "package.json"
    if (Test-Path -LiteralPath $rootPackagePath -PathType Leaf) {
        $packageJson = Get-Content -LiteralPath $rootPackagePath -Raw | ConvertFrom-Json
        $workspaceEntries = @()

        if ($packageJson.PSObject.Properties.Name -contains "workspaces") {
            if ($packageJson.workspaces -is [array]) {
                $workspaceEntries = $packageJson.workspaces
            }
            elseif ($packageJson.workspaces.PSObject.Properties.Name -contains "packages") {
                $workspaceEntries = $packageJson.workspaces.packages
            }
        }

        foreach ($workspace in $workspaceEntries) {
            Add-DxWorkspacePackageInputs $workspace
        }
    }
}

if ($ListInputsOnly) {
    foreach ($input in $inputList) {
        Write-Output (ConvertTo-IndexPath $input)
    }
    exit 0
}

$serializerManifestPath = Resolve-Path -LiteralPath $SerializerManifest
$serializerEvidenceLockInfo = Get-DxSerializerEvidenceLock -ManifestPath $serializerManifestPath.Path -ExecutableOverride $SerializerExe
New-Item -ItemType Directory -Force -Path $outputPath | Out-Null

$generated = @()
$indexEntries = @()
$existingInputs = [System.Collections.Generic.List[string]]::new()
$defaultCompressionFlag = "--no-compression"

Push-Location -LiteralPath $repoRoot
try {
    foreach ($input in $inputList) {
        $sourcePath = Join-Path $repoRoot $input
        if (Test-Path -LiteralPath $sourcePath -PathType Leaf) {
            [void]$existingInputs.Add($input)
        }
    }

    $serializerExecutable = $null
    if ($existingInputs.Count -gt 0) {
        Assert-DxUniqueCacheStems -InputPaths $existingInputs
        $serializerExecutable = Get-DxSerializerExecutable -ManifestPath $serializerManifestPath
        Invoke-DxSerializerBatch -ExecutablePath $serializerExecutable -InputPaths $existingInputs -CompressionFlag $defaultCompressionFlag
    }
    elseif (-not $NoIndex) {
        $serializerExecutable = Get-DxSerializerExecutable -ManifestPath $serializerManifestPath
    }

    foreach ($input in $existingInputs) {
        $sourcePath = Join-Path $repoRoot $input
        $stem = Get-DxCacheStem $input
        $kind = Get-DxCacheKind $input
        $machinePath = Join-Path $outputPath "$stem.machine"
        $metadataPath = Join-Path $outputPath "$stem.machine.meta.json"
        $sourceIndexPath = ConvertTo-IndexPath $input
        $cacheOutput = Get-DxMachineCacheOutput -MachinePath $machinePath -MetadataPath $metadataPath -SourcePath $sourcePath -SourceIndexPath $sourceIndexPath
        $keyInterningItem = $null

        $generated += $machinePath
        $generated += $metadataPath

        $sourceBlake3 = [string]$cacheOutput.MetadataJson.source.blake3
        $sourceHashPrefix = $sourceBlake3.Substring(0, [System.Math]::Min(2, $sourceBlake3.Length)).ToLowerInvariant()
        $shard = $kind + "/" + $sourceHashPrefix
        if (Test-DxColdLargeShard -Kind $kind -Shard $shard -MachineBytes $cacheOutput.MachineItem.Length) {
            Invoke-DxSerializer `
                -ExecutablePath $serializerExecutable `
                -InputPath $input `
                -CompressionFlag (Get-DxMachineCacheCompressionFlag -Compression $ColdLargeShardCompression)
            $cacheOutput = Get-DxMachineCacheOutput -MachinePath $machinePath -MetadataPath $metadataPath -SourcePath $sourcePath -SourceIndexPath $sourceIndexPath
        }

        if ($kind -eq "package_json") {
            $keyInterningPath = Join-Path $outputPath "$stem.keys.json"
            $keyInterningItem = Write-DxPackageJsonKeyInterningSidecar -SourcePath $sourcePath -Path $keyInterningPath
            $generated += $keyInterningItem.FullName
        }

        $indexEntry = [ordered]@{
            source = ConvertTo-IndexPath $input
            kind = $kind
            stem = $stem
            machine = ConvertTo-RepoRelativePath $cacheOutput.MachineItem.FullName
            metadata = ConvertTo-RepoRelativePath $cacheOutput.MetadataItem.FullName
            sourceBytes = $cacheOutput.MetadataJson.source.bytes
            sourceModifiedUnixMs = $cacheOutput.MetadataJson.source.modified_unix_ms
            sourceBlake3 = $cacheOutput.MetadataJson.source.blake3
            machineBlake3 = $cacheOutput.MetadataJson.machine.blake3
            machineBytes = $cacheOutput.MachineItem.Length
            metadataBytes = $cacheOutput.MetadataItem.Length
        }
        if ($null -ne $keyInterningItem) {
            $indexEntry.keyInterning = ConvertTo-RepoRelativePath $keyInterningItem.FullName
        }
        $indexEntries += $indexEntry
    }
}
finally {
    Pop-Location
}

if (-not $NoIndex) {
    $indexPath = Join-Path $outputPath "index.json"
    $indexTempPath = Join-Path $outputPath ("index." + [System.Guid]::NewGuid().ToString("N") + ".tmp")
    $catalogPath = Join-Path $outputPath "catalog.json"
    $catalogTempPath = Join-Path $outputPath ("catalog." + [System.Guid]::NewGuid().ToString("N") + ".tmp")
    $catalogMachinePath = Join-Path $outputPath "catalog.machine"
    $trustedPackageJsonSnapshotPath = Join-Path $outputPath "package-json-read.trusted"
    $shardRootPath = Join-Path $outputPath "shards"
    $generatedAtUtc = [System.DateTimeOffset]::UtcNow.ToString("o")
    $serializerIdentity = New-DxSerializerIdentity -ManifestPath $serializerManifestPath.Path -ExecutablePath $serializerExecutable -EvidenceLock $serializerEvidenceLockInfo
    $trustedCatalogEntries = @($indexEntries | Where-Object { Test-DxTrustedCatalogKind -Kind ([string]$_.kind) })
    $indexPayload = [ordered]@{
        schema = "dx.js.machine_cache_index.v1"
        generatedAtUtc = $generatedAtUtc
        serializer = $serializerIdentity
        entries = $indexEntries
    }
    $catalogPayload = New-DxMachineCacheCatalog `
        -Entries $trustedCatalogEntries `
        -GeneratedAtUtc $generatedAtUtc `
        -ShardSourceHashPrefixLength $ShardSourceHashPrefixLength
    $catalogPayload["serializer"] = $serializerIdentity
    $indexJson = ($indexPayload | ConvertTo-Json -Depth 5) + [System.Environment]::NewLine
    $catalogJson = ($catalogPayload | ConvertTo-Json -Depth 5) + [System.Environment]::NewLine
    [System.IO.File]::WriteAllText($indexTempPath, $indexJson, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($catalogTempPath, $catalogJson, [System.Text.UTF8Encoding]::new($false))
    try {
        $artifactPaths = Invoke-DxSerializerCacheArtifacts `
            -ExecutablePath $serializerExecutable `
            -Catalog $catalogPayload `
            -CatalogJson $catalogJson `
            -CatalogJsonPath $catalogTempPath `
            -OutputPath $outputPath `
            -CatalogMachinePath $catalogMachinePath `
            -ShardRoot $shardRootPath `
            -ShardPathIdentityRoot (Join-Path $safeOutputDir "shards")
        Move-Item -LiteralPath $indexTempPath -Destination $indexPath -Force
        Move-Item -LiteralPath $catalogTempPath -Destination $catalogPath -Force
        $trustedPackageJsonSnapshotItem = Write-DxPackageJsonReadTrustMarker `
            -Path $trustedPackageJsonSnapshotPath `
            -GeneratedAtUtc $generatedAtUtc
    }
    catch {
        Remove-Item -LiteralPath $indexTempPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $catalogTempPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $trustedPackageJsonSnapshotPath -Force -ErrorAction SilentlyContinue
        throw
    }
    $generated += $indexPath
    $generated += $catalogPath
    $generated += $artifactPaths
    $generated += $trustedPackageJsonSnapshotItem.FullName
}

Write-Host "DX JS machine cache output:"
foreach ($path in $generated) {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        $item = Get-Item -LiteralPath $path
        Write-Host ("  {0} ({1} bytes)" -f $item.FullName, $item.Length)
    }
}
