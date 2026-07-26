#Requires -Version 5.1
<#
Shared Windows guard logic for Decagram Council.

All path decisions are case-insensitive and use forward slashes after
normalization. Messages retain the original path spelling from the hook
payload. These hooks are policy checks, not an operating-system security
boundary.
#>

Set-StrictMode -Version 2.0

function Get-GuardProperty {
    param(
        $InputObject,
        [string]$Name
    )

    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-GuardPayload {
    param([string]$PayloadText)

    if ([string]::IsNullOrWhiteSpace($PayloadText)) {
        $PayloadText = [Console]::In.ReadToEnd()
    }
    if ([string]::IsNullOrWhiteSpace($PayloadText)) {
        throw 'empty hook payload'
    }

    try {
        return $PayloadText | ConvertFrom-Json
    } catch {
        throw 'unparseable hook payload'
    }
}

function Get-GuardProjectDir {
    param($Payload)

    $projectDir = $env:CLAUDE_PROJECT_DIR
    $payloadCwd = Get-GuardProperty -InputObject $Payload -Name 'cwd'
    if ([string]::IsNullOrWhiteSpace($projectDir) -and $null -ne $payloadCwd) {
        $projectDir = [string]$payloadCwd
    }
    if ([string]::IsNullOrWhiteSpace($projectDir)) {
        $projectDir = (Get-Location).Path
    }
    return [IO.Path]::GetFullPath($projectDir)
}

function Resolve-GuardPath {
    param(
        $Payload,
        [string]$AgentLabel
    )

    $toolInput = Get-GuardProperty -InputObject $Payload -Name 'tool_input'
    $filePath = [string](Get-GuardProperty -InputObject $toolInput -Name 'file_path')
    if ([string]::IsNullOrWhiteSpace($filePath)) {
        throw "${AgentLabel} write guard: missing tool_input.file_path"
    }

    if ($filePath -match '(^|[\\/])\.\.([\\/]|$)') {
        throw "${AgentLabel} write guard: path contains '..' traversal ($filePath)"
    }

    $projectDir = Get-GuardProjectDir -Payload $Payload
    $candidate = $filePath -replace '/', [IO.Path]::DirectorySeparatorChar
    if (-not [IO.Path]::IsPathRooted($candidate)) {
        $candidate = Join-Path $projectDir $candidate
    }

    try {
        $absolute = [IO.Path]::GetFullPath($candidate)
    } catch {
        throw "${AgentLabel} write guard: invalid target path ($filePath)"
    }

    if (Test-Path -LiteralPath $absolute) {
        try {
            $absolute = (Resolve-Path -LiteralPath $absolute).Path
        } catch {
            # GetFullPath is still a normalized, conservative spelling.
        }
    }

    $root = [IO.Path]::GetFullPath($projectDir).TrimEnd('\', '/')
    $prefix = $root + [IO.Path]::DirectorySeparatorChar
    if ($absolute.Equals($root, [StringComparison]::OrdinalIgnoreCase)) {
        $relative = ''
    } elseif ($absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        $relative = $absolute.Substring($prefix.Length)
    } else {
        throw "${AgentLabel} write guard: target is outside the project ($filePath)"
    }

    $relative = ($relative -replace '\\', '/').TrimStart('/')
    $relative = $relative -replace '/+', '/'
    $relative = $relative.ToLowerInvariant()

    if ($relative -match '^\.claude/worktrees/[^/]+/(.+)$') {
        $relative = $Matches[1]
    }

    return [pscustomobject]@{
        Original = $filePath
        Relative = $relative
        Absolute = $absolute
        ProjectDir = $root
    }
}

function Test-GuardLike {
    param(
        [string]$Path,
        [string[]]$Patterns
    )

    foreach ($pattern in $Patterns) {
        if ($Path -like $pattern) { return $true }
    }
    return $false
}

function Test-GuardProduction {
    param([string]$Path)
    return Test-GuardLike $Path @(
        'src/*', 'lib/*', 'app/*', 'server/*', 'packages/*/src/*',
        'migrations/*', '*/migrations/*', 'db/migrate/*',
        'deploy/*', 'infra/*', 'terraform/*', '.github/workflows/*',
        'dockerfile', 'dockerfile.*', 'docker-compose*.yml',
        'package.json', 'package-lock.json', 'tsconfig*.json',
        'vitest.config.*', 'electron-builder.*'
    )
}

function Test-GuardTest {
    param([string]$Path)
    return Test-GuardLike $Path @(
        'test/*', 'tests/*', 'spec/*', '__tests__/*', '*/__tests__/*',
        '*.test.*', '*.spec.*', '*_test.go', '*_test.py', 'test_*.py',
        '*fixtures/*', '*__fixtures__/*', '*/testdata/*',
        'scripts/acceptance/*'
    )
}

function Test-GuardPrd {
    param([string]$Path)
    return Test-GuardLike $Path @(
        'docs/prd/*', 'docs/prd.md', 'docs/prd-changes/*',
        'docs/prd_changes/*'
    )
}

function Test-GuardEpic {
    param([string]$Path)
    return Test-GuardLike $Path @('epics/*', 'docs/epics/*')
}

function Test-GuardStory {
    param([string]$Path)
    return Test-GuardLike $Path @('stories/*', 'docs/stories/*')
}

function Test-GuardPlanning {
    param([string]$Path)
    return Test-GuardLike $Path @(
        'docs/planning/*', 'docs/decisions/*', 'docs/adr/*',
        'docs/research/*', 'docs/discovery/*'
    )
}

function Test-GuardGateScript {
    param([string]$Path)
    return Test-GuardLike $Path @('scripts/gates/*', '.claude/hooks/*')
}

function Test-GuardClaudeConfig {
    param([string]$Path)
    return Test-GuardLike $Path @(
        '.claude/settings.json', '.claude/settings.local.json',
        '.claude/settings.*.json', '.claude/hooks/*', '.mcp.json',
        'claude.md', 'claude.local.md'
    )
}

function Test-GuardAgentDefinition {
    param([string]$Path)
    return Test-GuardLike $Path @('.claude/agents/*', 'claude-code-agent-pack/*')
}

function Test-GuardOwnMemory {
    param([string]$Path, [string]$AgentType)
    return $Path -like ".claude/agent-memory/$AgentType/*"
}

function Test-GuardForeignMemory {
    param([string]$Path, [string]$AgentType)
    return $Path -like '.claude/agent-memory/*' -and
        -not (Test-GuardOwnMemory -Path $Path -AgentType $AgentType)
}

function Get-GuardWriteBlockReason {
    param(
        [string]$AgentType,
        [string]$RelativePath
    )

    if (Test-GuardClaudeConfig $RelativePath) {
        return "$AgentType must not modify Claude configuration ($RelativePath)."
    }
    if (Test-GuardGateScript $RelativePath) {
        return "$AgentType must not modify guard or gate scripts ($RelativePath)."
    }
    if (Test-GuardAgentDefinition $RelativePath) {
        return "$AgentType must not modify agent definitions ($RelativePath)."
    }
    if (Test-GuardForeignMemory $RelativePath $AgentType) {
        return "$AgentType may only modify its own agent-memory directory ($RelativePath)."
    }

    switch ($AgentType) {
        'builder' {
            if (Test-GuardPrd $RelativePath) { return "Builder must not edit PRD documents ($RelativePath)." }
            if (Test-GuardEpic $RelativePath) { return "Builder must not edit epic files ($RelativePath)." }
            if (Test-GuardStory $RelativePath) { return "Builder must not edit story files ($RelativePath)." }
            if (Test-GuardTest $RelativePath) { return "Builder must not write tests or acceptance artifacts ($RelativePath)." }
            return $null
        }
        'test-engineer' {
            if (Test-GuardTest $RelativePath) { return $null }
            if (Test-GuardStory $RelativePath) { return $null }
            if (Test-GuardOwnMemory $RelativePath $AgentType) { return $null }
            return "Test Engineer may write only tests, story acceptance fields, and its own memory ($RelativePath)."
        }
        'prd-lead' {
            if (Test-GuardPrd $RelativePath) { return $null }
            if (Test-GuardEpic $RelativePath) { return $null }
            if (Test-GuardStory $RelativePath) { return $null }
            if (Test-GuardPlanning $RelativePath) { return $null }
            if (Test-GuardOwnMemory $RelativePath $AgentType) { return $null }
            return "PRD Lead may write only planning artifacts and its own memory ($RelativePath)."
        }
        default { return $null }
    }
}

function Write-GuardAudit {
    param(
        [string]$ProjectDir,
        [string]$Event,
        [string]$AgentType,
        [string]$Target,
        [string]$Decision
    )

    try {
        $directory = Join-Path $ProjectDir '.claude'
        if (-not (Test-Path -LiteralPath $directory)) {
            New-Item -ItemType Directory -Path $directory -Force | Out-Null
        }
        $cleanTarget = ($Target -replace "[`r`n`t]", ' ')
        $cleanDecision = ($Decision -replace "[`r`n`t]", ' ')
        $line = "{0}`t{1}`t{2}`t{3}`t{4}" -f
            ([DateTime]::UtcNow.ToString('o')), $Event, $AgentType,
            $cleanTarget, $cleanDecision
        Add-Content -LiteralPath (Join-Path $directory 'gate-audit.log') -Value $line
    } catch {
        # Auditing must not replace the policy decision with an unrelated error.
    }
}

function Get-GuardChangedPaths {
    param([string]$ProjectDir)

    if ($null -eq (Get-Command git -ErrorAction SilentlyContinue)) {
        throw 'Git is unavailable.'
    }

    $paths = [System.Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    $output = @()
    $output += & git -C $ProjectDir diff --name-only 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Git could not read unstaged changes.' }
    $output += & git -C $ProjectDir diff --cached --name-only 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Git could not read staged changes.' }
    $output += & git -C $ProjectDir ls-files --others --exclude-standard 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Git could not read untracked files.' }

    foreach ($item in $output) {
        if (-not [string]::IsNullOrWhiteSpace($item)) {
            [void]$paths.Add(($item -replace '\\', '/').ToLowerInvariant())
        }
    }
    return @($paths)
}
