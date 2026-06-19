[CmdletBinding()]
param(
    [string]$AgentId = "",
    [ValidateRange(1, 64)]
    [int]$LaneCount = 6,
    [string]$PlanPath = "PLAN.md",
    [int]$ExpectedTaskCount = 30,
    [string]$RepoRoot = "",
    [string]$StateDir = "",
    [switch]$Reset,
    [switch]$ShowAll
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
    param([string]$RequestedRoot)

    if ($RequestedRoot.Trim().Length -gt 0) {
        return (Resolve-Path -LiteralPath $RequestedRoot).Path
    }

    $root = (& git rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($root)) {
        throw "Run this script inside G:\Dx\bun or pass -RepoRoot."
    }

    return ($root.Trim() -replace "/", "\")
}

function Get-StableHash {
    param([string]$Text)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        $hash = $sha.ComputeHash($bytes)
        return -join ($hash | ForEach-Object { $_.ToString("x2") })
    }
    finally {
        $sha.Dispose()
    }
}

function Resolve-StateDir {
    param(
        [string]$RequestedStateDir,
        [string]$ResolvedRepoRoot
    )

    if ($RequestedStateDir.Trim().Length -gt 0) {
        if ([System.IO.Path]::IsPathRooted($RequestedStateDir)) {
            return $RequestedStateDir
        }

        return (Join-Path $ResolvedRepoRoot $RequestedStateDir)
    }

    $localAppData = [Environment]::GetFolderPath("LocalApplicationData")
    if ([string]::IsNullOrWhiteSpace($localAppData)) {
        $localAppData = [System.IO.Path]::GetTempPath()
    }

    $repoHash = (Get-StableHash -Text $ResolvedRepoRoot).Substring(0, 16)
    return (Join-Path $localAppData "Dx\bun-worker-lanes\$repoHash")
}

function Resolve-PlanPath {
    param(
        [string]$RequestedPlanPath,
        [string]$ResolvedRepoRoot
    )

    if ([System.IO.Path]::IsPathRooted($RequestedPlanPath)) {
        return $RequestedPlanPath
    }

    return (Join-Path $ResolvedRepoRoot $RequestedPlanPath)
}

function Encode-Field {
    param([string]$Value)
    return [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Value))
}

function Decode-Field {
    param([string]$Value)
    return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}

function Get-AgentIdentity {
    param([string]$RequestedAgentId)

    $trimmed = $RequestedAgentId.Trim()
    if ($trimmed.Length -gt 0) {
        return [pscustomobject]@{
            AgentId = $trimmed
            Source = "argument"
            Generated = $false
        }
    }

    $envNames = @(
        "DX_WORKER_AGENT_ID",
        "CODEX_SUBAGENT_ID",
        "CODEX_AGENT_ID",
        "CODEX_WORKER_ID",
        "CODEX_THREAD_ID",
        "OPENAI_THREAD_ID"
    )

    foreach ($name in $envNames) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return [pscustomobject]@{
                AgentId = $value.Trim()
                Source = "env:$name"
                Generated = $false
            }
        }
    }

    return [pscustomobject]@{
        AgentId = "manual-" + [guid]::NewGuid().ToString("N")
        Source = "generated"
        Generated = $true
    }
}

function New-Task {
    param(
        [int]$Number,
        [int]$Line,
        [string]$Title,
        [string]$Kind
    )

    return [pscustomobject]@{
        Number = $Number
        Line = $Line
        Title = ($Title.Trim() -replace "\s+", " ")
        Kind = $Kind
    }
}

function Read-PlanTasks {
    param(
        [string]$ResolvedPlanPath,
        [int]$ExpectedCount
    )

    if (-not (Test-Path -LiteralPath $ResolvedPlanPath)) {
        return [pscustomobject]@{
            Found = $false
            Path = $ResolvedPlanPath
            Hash = ""
            Mode = "missing"
            Warning = "NEEDS_CONTEXT: Plan file not found. Create PLAN.md at this path or pass -PlanPath."
            Tasks = @()
        }
    }

    $content = Get-Content -Raw -LiteralPath $ResolvedPlanPath
    $hash = Get-StableHash -Text $content
    $lines = $content -split "\r?\n"
    $taskHeadings = New-Object System.Collections.Generic.List[object]
    $tableRows = New-Object System.Collections.Generic.List[object]
    $checklist = New-Object System.Collections.Generic.List[object]
    $numbered = New-Object System.Collections.Generic.List[object]

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $lineNumber = $i + 1
        $line = $lines[$i]

        if ($line -match '^\s{0,3}#{1,6}\s+Task\s+([0-9]+)\s*[:.\-]?\s*(.+?)\s*$') {
            $taskHeadings.Add((New-Task -Number ([int]$Matches[1]) -Line $lineNumber -Title $Matches[2] -Kind "heading"))
            continue
        }

        if ($line -match "^\s*\|\s*([0-9]+)\s*\|") {
            $rowText = $line.Trim() -replace "^\|", "" -replace "\|$", ""
            $cells = @(($rowText -split "\|") | ForEach-Object { $_.Trim() })

            if ($cells.Count -ge 3 -and $cells[0] -match "^[0-9]+$") {
                $title = $cells[1]
                if ($cells[2].Trim().Length -gt 0) {
                    $title = "$title -> $($cells[2])"
                }

                $tableRows.Add((New-Task -Number ([int]$cells[0]) -Line $lineNumber -Title $title -Kind "table-option"))
                continue
            }
        }

        if ($line -match "^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$") {
            $checklist.Add((New-Task -Number ($checklist.Count + 1) -Line $lineNumber -Title $Matches[1] -Kind "checklist"))
            continue
        }

        if ($line -match "^\s*([0-9]+)[.)]\s+(.+?)\s*$") {
            $numbered.Add((New-Task -Number ([int]$Matches[1]) -Line $lineNumber -Title $Matches[2] -Kind "numbered"))
            continue
        }
    }

    $candidates = @(
        [pscustomobject]@{ Mode = "table-options"; Tasks = @($tableRows.ToArray()) },
        [pscustomobject]@{ Mode = "task-headings"; Tasks = @($taskHeadings.ToArray()) },
        [pscustomobject]@{ Mode = "checklist"; Tasks = @($checklist.ToArray()) },
        [pscustomobject]@{ Mode = "numbered"; Tasks = @($numbered.ToArray()) }
    )

    $selected = $candidates | Where-Object { $_.Tasks.Count -eq $ExpectedCount } | Select-Object -First 1
    if ($null -eq $selected) {
        $selected = $candidates | Sort-Object { $_.Tasks.Count } -Descending | Select-Object -First 1
    }

    $tasks = @($selected.Tasks)
    $warning = ""
    if ($tasks.Count -ne $ExpectedCount) {
        $warning = "PLAN_TASK_COUNT_WARNING: expected $ExpectedCount tasks, parsed $($tasks.Count) using mode '$($selected.Mode)'. Workers must verify PLAN.md before claiming all work is covered."
    }

    return [pscustomobject]@{
        Found = $true
        Path = $ResolvedPlanPath
        Hash = $hash
        Mode = $selected.Mode
        Warning = $warning
        Tasks = $tasks
    }
}

function Get-LaneRange {
    param(
        [int]$TaskCount,
        [int]$Lane,
        [int]$TotalLanes
    )

    $base = [math]::Floor($TaskCount / $TotalLanes)
    $extra = $TaskCount % $TotalLanes
    $start = 1

    for ($i = 1; $i -lt $Lane; $i++) {
        $start += $base
        if ($i -le $extra) {
            $start += 1
        }
    }

    $size = $base
    if ($Lane -le $extra) {
        $size += 1
    }

    $end = $start + $size - 1
    if ($TaskCount -eq 0) {
        $start = 0
        $end = 0
    }

    return [pscustomobject]@{
        Start = $start
        End = $end
        Size = $size
    }
}

function New-State {
    return [ordered]@{
        Version = "1"
        RunCounter = 0
        AssignmentCounter = 0
        LaneCount = $LaneCount
        PlanHash = ""
        Assignments = @{}
    }
}

function Read-State {
    param([string]$Path)

    $state = New-State
    if (-not (Test-Path -LiteralPath $Path)) {
        return $state
    }

    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        if ($line.StartsWith("version=")) { $state.Version = $line.Substring("version=".Length); continue }
        if ($line.StartsWith("run_counter=")) { $state.RunCounter = [int]$line.Substring("run_counter=".Length); continue }
        if ($line.StartsWith("assignment_counter=")) { $state.AssignmentCounter = [int]$line.Substring("assignment_counter=".Length); continue }
        if ($line.StartsWith("lane_count=")) { $state.LaneCount = [int]$line.Substring("lane_count=".Length); continue }
        if ($line.StartsWith("plan_hash=")) { $state.PlanHash = $line.Substring("plan_hash=".Length); continue }

        if ($line.StartsWith("assignment`t")) {
            $parts = $line -split "`t"
            if ($parts.Count -lt 7) {
                continue
            }

            $agent = Decode-Field -Value $parts[1]
            $state.Assignments[$agent] = [ordered]@{
                Lane = [int]$parts[2]
                Claim = [int]$parts[3]
                AssignedUtc = $parts[4]
                LastSeenUtc = $parts[5]
                RunCount = [int]$parts[6]
            }
        }
    }

    return $state
}

function Write-State {
    param(
        [string]$Path,
        [hashtable]$State
    )

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("dx_bun_lane_state=1")
    $lines.Add("version=$($State.Version)")
    $lines.Add("run_counter=$($State.RunCounter)")
    $lines.Add("assignment_counter=$($State.AssignmentCounter)")
    $lines.Add("lane_count=$($State.LaneCount)")
    $lines.Add("plan_hash=$($State.PlanHash)")
    $lines.Add("updated_utc=$([DateTimeOffset]::UtcNow.ToString("o"))")

    foreach ($agent in ($State.Assignments.Keys | Sort-Object)) {
        $entry = $State.Assignments[$agent]
        $lines.Add(("assignment`t{0}`t{1}`t{2}`t{3}`t{4}`t{5}" -f `
            (Encode-Field -Value $agent),
            $entry.Lane,
            $entry.Claim,
            $entry.AssignedUtc,
            $entry.LastSeenUtc,
            $entry.RunCount))
    }

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($Path, $lines, $encoding)
}

function Write-MachineContract {
    param(
        [string]$Path,
        [hashtable]$State,
        [object]$Plan,
        [string]$ResolvedRepoRoot,
        [int]$TotalLanes
    )

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("dx_bun_worker_lane_contract.machine=1")
    $lines.Add("repo=$ResolvedRepoRoot")
    $lines.Add("plan=$($Plan.Path)")
    $lines.Add("plan_found=$($Plan.Found)")
    $lines.Add("plan_hash=$($Plan.Hash)")
    $lines.Add("task_mode=$($Plan.Mode)")
    $lines.Add("task_count=$($Plan.Tasks.Count)")
    $lines.Add("expected_task_count=$ExpectedTaskCount")
    $lines.Add("lane_count=$TotalLanes")
    $lines.Add("run_counter=$($State.RunCounter)")
    $lines.Add("assignment_counter=$($State.AssignmentCounter)")
    $lines.Add("updated_utc=$([DateTimeOffset]::UtcNow.ToString("o"))")

    for ($lane = 1; $lane -le $TotalLanes; $lane++) {
        $range = Get-LaneRange -TaskCount $Plan.Tasks.Count -Lane $lane -TotalLanes $TotalLanes
        $lines.Add(("lane`t{0}`t{1}`t{2}`t{3}" -f $lane, $range.Start, $range.End, $range.Size))
    }

    foreach ($task in $Plan.Tasks) {
        $lines.Add(("task`t{0}`t{1}`t{2}`t{3}" -f $task.Number, $task.Line, (Encode-Field -Value $task.Kind), (Encode-Field -Value $task.Title)))
    }

    foreach ($agent in ($State.Assignments.Keys | Sort-Object)) {
        $entry = $State.Assignments[$agent]
        $lines.Add(("assignment`t{0}`t{1}`t{2}`t{3}" -f (Encode-Field -Value $agent), $entry.Lane, $entry.Claim, $entry.LastSeenUtc))
    }

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($Path, $lines, $encoding)
}

$resolvedRepoRoot = Resolve-RepoRoot -RequestedRoot $RepoRoot
$resolvedPlanPath = Resolve-PlanPath -RequestedPlanPath $PlanPath -ResolvedRepoRoot $resolvedRepoRoot
$resolvedStateDir = Resolve-StateDir -RequestedStateDir $StateDir -ResolvedRepoRoot $resolvedRepoRoot
$statePath = Join-Path $resolvedStateDir "bun-plan-lanes.sr"
$machinePath = Join-Path $resolvedStateDir "bun-plan-lanes.machine"
$agentIdentity = Get-AgentIdentity -RequestedAgentId $AgentId
$mutexName = "Local\DxBunPlanLaneAllocator_$((Get-StableHash -Text $resolvedRepoRoot).Substring(0, 16))"
$mutex = [System.Threading.Mutex]::new($false, $mutexName)
$hasLock = $false

try {
    $hasLock = $mutex.WaitOne([TimeSpan]::FromSeconds(30))
    if (-not $hasLock) {
        throw "Timed out waiting for the Bun lane allocator lock."
    }

    New-Item -ItemType Directory -Force -Path $resolvedStateDir | Out-Null

    if ($Reset) {
        Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $machinePath -Force -ErrorAction SilentlyContinue
    }

    $plan = Read-PlanTasks -ResolvedPlanPath $resolvedPlanPath -ExpectedCount $ExpectedTaskCount
    $state = Read-State -Path $statePath
    $now = [DateTimeOffset]::UtcNow.ToString("o")
    $state.RunCounter = [int]$state.RunCounter + 1
    $state.LaneCount = $LaneCount
    $state.PlanHash = $plan.Hash

    $agentId = $agentIdentity.AgentId
    $isNewAssignment = -not $state.Assignments.ContainsKey($agentId)

    if ($isNewAssignment) {
        $state.AssignmentCounter = [int]$state.AssignmentCounter + 1
        $laneNumber = (([int]$state.AssignmentCounter - 1) % $LaneCount) + 1
        $state.Assignments[$agentId] = [ordered]@{
            Lane = $laneNumber
            Claim = [int]$state.AssignmentCounter
            AssignedUtc = $now
            LastSeenUtc = $now
            RunCount = 1
        }
    }
    else {
        $state.Assignments[$agentId].LastSeenUtc = $now
        $state.Assignments[$agentId].RunCount = [int]$state.Assignments[$agentId].RunCount + 1
    }

    Write-State -Path $statePath -State $state
    Write-MachineContract -Path $machinePath -State $state -Plan $plan -ResolvedRepoRoot $resolvedRepoRoot -TotalLanes $LaneCount

    $assignment = $state.Assignments[$agentId]
    $range = Get-LaneRange -TaskCount $plan.Tasks.Count -Lane $assignment.Lane -TotalLanes $LaneCount

    Write-Output "# Bun PLAN.md Lane Assignment"
    Write-Output ""
    Write-Output "repo: $resolvedRepoRoot"
    Write-Output "plan: $($plan.Path)"
    Write-Output "planFound: $($plan.Found)"
    Write-Output "taskMode: $($plan.Mode)"
    Write-Output "taskCount: $($plan.Tasks.Count)"
    Write-Output "expectedTaskCount: $ExpectedTaskCount"
    Write-Output "laneCount: $LaneCount"
    Write-Output "runCounter: $($state.RunCounter)"
    Write-Output "assignmentCounter: $($state.AssignmentCounter)"
    Write-Output "agentId: $agentId"
    Write-Output "agentIdSource: $($agentIdentity.Source)"
    Write-Output "generatedAgentId: $($agentIdentity.Generated)"
    Write-Output "newAssignment: $isNewAssignment"
    Write-Output "lane: $($assignment.Lane)"
    Write-Output "taskRange: $($range.Start)-$($range.End)"
    Write-Output "stateFile: $statePath"
    Write-Output "machineFile: $machinePath"
    Write-Output "resumeCommand: powershell -NoProfile -ExecutionPolicy Bypass -File `"$resolvedRepoRoot\scripts\codex\claim-bun-plan-lane.ps1`" -AgentId `"$agentId`""

    if ($plan.Warning.Trim().Length -gt 0) {
        Write-Output ""
        Write-Output $plan.Warning
    }

    if ($agentIdentity.Generated) {
        Write-Output ""
        Write-Output "IMPORTANT: No stable Codex agent id was found. Reuse the resumeCommand above in this same worker chat so you keep this lane."
    }

    Write-Output ""
    Write-Output "## Your Lane Tasks"
    if ($plan.Tasks.Count -eq 0 -or $range.Size -le 0) {
        Write-Output "- NEEDS_CONTEXT: no parsed tasks are available for this lane."
    }
    else {
        $laneTasks = $plan.Tasks | Where-Object { $_.Number -ge $range.Start -and $_.Number -le $range.End }
        foreach ($task in $laneTasks) {
            Write-Output ("- Task {0} (line {1}, {2}): {3}" -f $task.Number, $task.Line, $task.Kind, $task.Title)
        }
    }

    Write-Output ""
    Write-Output "## Worker Rules"
    Write-Output "- Complete only your assigned PLAN.md tasks unless the coordinator explicitly reassigns you."
    Write-Output "- Use [@superpowers](plugin://superpowers@openai-curated) first."
    Write-Output "- Use exactly 6 GPT-5.5 extra-high subagents inside your lane."
    Write-Output "- Keep subagent scopes isolated and non-overlapping."
    Write-Output "- Do not create .cjs, .mjs, or .js scripts. Use .ts, Rust, or existing repo-native tools."
    Write-Output "- Start with rg/source scans and targeted tests. Avoid broad/heavy commands early."
    Write-Output "- Follow Bun repo rules from CLAUDE.md, especially using bun bd test for runtime changes."
    Write-Output "- Commit only your lane work and report DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, or BLOCKED."

    if ($ShowAll) {
        Write-Output ""
        Write-Output "## All Assignments"
        foreach ($agent in ($state.Assignments.Keys | Sort-Object)) {
            $entry = $state.Assignments[$agent]
            Write-Output "- lane=$($entry.Lane) claim=$($entry.Claim) runs=$($entry.RunCount) agent=$agent"
        }
    }

    if (-not $plan.Found) {
        exit 2
    }
}
finally {
    if ($hasLock) {
        $mutex.ReleaseMutex()
    }

    $mutex.Dispose()
}
