#requires -Version 7.0

[CmdletBinding()]
param(
    [string]$Profile,
    [string[]]$ExcludeProfile = @(),
    [string]$QuestionCount,
    [switch]$DryRun,
    [string]$Seed,
    [string]$NodePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if (-not $IsWindows) { throw 'This command requires Windows and Microsoft Edge.' }
if (-not $NodePath) {
    $NodePath = & mise.exe --cd $PSScriptRoot which node
    if ($LASTEXITCODE -ne 0 -or @($NodePath).Count -ne 1 -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
        throw 'A mise-managed Node executable is required.'
    }
}
$cli = Join-Path $PSScriptRoot 'dist/src/main.js'
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw 'Run npm ci and npm run build first.' }
$modulePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'gpt-usage/src/GptUsage.psm1'
$module = Import-Module $modulePath -Force -PassThru

# Reuse gpt-usage selection, browser isolation flags, and its device-wide lock.
& $module {
    param($SelectedProfile, $ExcludedProfiles, $Cli, $Node, $Count, $Preview, $RunSeed)
    $model = Get-GptUsageModel -RequireEdge
    Invoke-GptUsageDeviceOperation -ProfileRoot $model.ProfileRoot -Action {
        $model = Get-GptUsageModel -RequireEdge
        $capturedProfiles = [Collections.Generic.List[object]]::new()
        Invoke-GptUsageOpen -Model $model -Profile $SelectedProfile -StartBrowser {
            param($Executable, $Arguments)
            if ($Arguments -notmatch '--user-data-dir="([^"]+)"') { throw 'Unexpected gpt-usage launch arguments.' }
            $path = $Matches[1]
            $entry = @($model.Profiles | Where-Object Path -CEQ $path)
            if ($entry.Count -ne 1) { throw 'Profile selection is ambiguous.' }
            if ($entry[0].Name -cin $ExcludedProfiles) { return }
            $capturedProfiles.Add([pscustomobject]@{ id = $entry[0].Id; name = $entry[0].Name; path = $path })
        } 6>$null
        if ($capturedProfiles.Count -eq 0) { throw 'No local dedicated profiles were found.' }
        $manifest = [pscustomobject]@{
            schemaVersion = 1
            edgePath = $model.EdgePath
            edgeArguments = @($script:EdgeArguments)
            profileRoot = $model.ProfileRoot
            profiles = @($capturedProfiles.ToArray())
        }
        [void][IO.Directory]::CreateDirectory('C:/dev/tmp')
        $temporary = Join-Path 'C:/dev/tmp' ('gpt-send-messages-' + [guid]::NewGuid().ToString('N') + '.json')
        try {
            [IO.File]::WriteAllText($temporary, ($manifest | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
            $arguments = @($Cli, '--manifest', $temporary)
            if ($null -ne $Count) { $arguments += @('--questions', [string]$Count) }
            if ($Preview) { $arguments += '--dry-run' }
            if ($RunSeed) { $arguments += @('--seed', $RunSeed) }
            & $Node @arguments
            if ($LASTEXITCODE -ne 0) { throw "Message runner failed with exit code $LASTEXITCODE." }
        }
        finally {
            if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        }
    }
} $Profile $ExcludeProfile $cli $NodePath $PSBoundParameters['QuestionCount'] $DryRun.IsPresent $Seed
