#Requires -Version 7.0
<#
.SYNOPSIS
  Install dsh-visual-explainer into a DeepSeek Harness profile.

.DESCRIPTION
  Two install shapes are supported:

    link (default)  add this clone directory as a `file:` dependency. pnpm
                    symlinks it, so edits take effect on the next Harness
                    reload/restart with no repack. Requires the clone to stay
                    where it is.

    pack            `pnpm pack` the source into dist\<name>-<version>.tgz, then
                    add that tarball as a `file:` dependency. pnpm copies the
                    contents into the profile's node_modules, so the installed
                    plugin keeps working even if this directory is moved or
                    deleted. Bump `version` in package.json before packing when
                    you need pnpm to re-copy an already-installed version.

  The script locates pnpm in this order: `-Pnpm`, `$env:DSH_DESKTOP_PNPM`, the
  bundled runtime under the running DeepSeek Harness app (`-AppRoot` overrides
  the guess), then `pnpm` on PATH.

  After pnpm finishes, the package is selected in the profile's
  `dsh.profile.bundles`, so the sidebar Plugin page lists it with an on/off
  switch. The bundle's own cordis.patch.yml inserts its row; no hand-written
  insert in the profile patch is needed (a legacy insert is reported).

  Neither mode touches the running process: the plugin registers its tools when
  Harness starts, so restart it once at the end.

.PARAMETER Profile
  Profile directory to install into. Defaults to `$env:DSH_PROFILE_DIR` when
  set, otherwise the desktop profile.

.PARAMETER Mode
  `link` or `pack`. Defaults to `link`.

.PARAMETER AppRoot
  DeepSeek Harness install directory (the folder containing the app's
  `resources\runtime\pnpm\bin\pnpm.mjs`). Only needed when auto-detection fails.

.PARAMETER Pnpm
  Explicit path to pnpm (a `pnpm.cmd`/`pnpm.exe` on PATH, or the bundled
  `pnpm.mjs`). Only needed when auto-detection fails.

.EXAMPLE
  pwsh -File install.ps1

.EXAMPLE
  pwsh -File install.ps1 -Mode pack

.EXAMPLE
  pwsh -File install.ps1 -Mode link -Pnpm "C:\Program Files\nodejs\pnpm.cmd"
#>
[CmdletBinding()]
param(
  [string]$Profile = $(if ($env:DSH_PROFILE_DIR) { $env:DSH_PROFILE_DIR } else { Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }),
  [ValidateSet('link', 'pack')]
  [string]$Mode = 'link',
  [string]$AppRoot = '',
  [string]$Pnpm = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSCommandPath
$dist = Join-Path $root 'dist'
$manifestPath = Join-Path $root 'package.json'

if (-not (Test-Path -LiteralPath $Profile -PathType Container)) {
  throw "profile directory not found: $Profile (pass -Profile <dir>)"
}
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "package.json not found next to install.ps1: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$packageName = $manifest.name

function Resolve-PnpmPath {
  if ($Pnpm) {
    if (-not (Test-Path -LiteralPath $Pnpm -PathType Leaf)) { throw "pnpm not found: $Pnpm" }
    return (Resolve-Path -LiteralPath $Pnpm).Path
  }
  if ($env:DSH_DESKTOP_PNPM -and (Test-Path -LiteralPath $env:DSH_DESKTOP_PNPM -PathType Leaf)) {
    return $env:DSH_DESKTOP_PNPM
  }

  $appRoots = @()
  if ($AppRoot) { $appRoots += $AppRoot }
  $appProcess = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($appProcess -and $appProcess.Path) { $appRoots += (Split-Path -Parent $appProcess.Path) }
  foreach ($candidateRoot in $appRoots) {
    $candidate = Join-Path $candidateRoot 'resources\runtime\pnpm\bin\pnpm.mjs'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }

  $command = Get-Command pnpm -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  throw 'pnpm not found: pass -Pnpm <path>, set DSH_DESKTOP_PNPM, pass -AppRoot, or put pnpm on PATH.'
}

function Invoke-Pnpm {
  param([string[]]$Arguments)
  if ($script:pnpmPath -like '*.mjs') {
    if (-not $script:nodePath) {
      throw 'the bundled pnpm is a .mjs script but no Node.js/Electron executable was found: set DSH_DESKTOP_NODE_EXECUTABLE or put node on PATH'
    }
    & $script:nodePath $script:pnpmPath @Arguments
  }
  else {
    & $script:pnpmPath @Arguments
  }
  if ($LASTEXITCODE -ne 0) { throw "pnpm failed with exit code $LASTEXITCODE" }
}

$script:pnpmPath = Resolve-PnpmPath
$script:nodePath = $null
if ($script:pnpmPath -like '*.mjs') {
  if ($env:DSH_DESKTOP_NODE_EXECUTABLE -and (Test-Path -LiteralPath $env:DSH_DESKTOP_NODE_EXECUTABLE -PathType Leaf)) {
    $script:nodePath = $env:DSH_DESKTOP_NODE_EXECUTABLE
    # The desktop app ships Electron; this makes it behave like plain Node.
    $env:ELECTRON_RUN_AS_NODE = '1'
  }
  else {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($nodeCommand) { $script:nodePath = $nodeCommand.Source }
  }
}

Write-Host "package:  $packageName@$($manifest.version)"
Write-Host "profile:  $Profile"
Write-Host "mode:     $Mode"
Write-Host "pnpm:     $script:pnpmPath"
if ($script:nodePath) { Write-Host "node:     $script:nodePath" }

if ($Mode -eq 'pack') {
  New-Item -ItemType Directory -Force -Path $dist | Out-Null
  Push-Location $root
  try {
    Invoke-Pnpm @('pack', '--pack-destination', $dist)
  }
  finally {
    Pop-Location
  }
  $tarball = Join-Path $dist "$packageName-$($manifest.version).tgz"
  if (-not (Test-Path -LiteralPath $tarball -PathType Leaf)) {
    throw "expected tarball was not produced: $tarball"
  }
  $spec = "file:$($tarball -replace '\\', '/')"
}
else {
  $spec = "file:$($root -replace '\\', '/')"
}

Write-Host "adding:   $spec"
Invoke-Pnpm @('--dir', $Profile, 'add', $spec)

$installed = Join-Path $Profile "node_modules\$packageName\package.json"
if (-not (Test-Path -LiteralPath $installed -PathType Leaf)) {
  throw "install finished but $installed is missing"
}
$installedManifest = Get-Content -LiteralPath $installed -Raw | ConvertFrom-Json
Write-Host ''
Write-Host "installed $packageName@$($installedManifest.version)"

# Select the package as a profile bundle so the Plugin page can toggle it.
$profileManifestPath = Join-Path $Profile 'package.json'
if (-not (Test-Path -LiteralPath $profileManifestPath -PathType Leaf)) {
  throw "profile package.json not found: $profileManifestPath"
}
$profileManifest = Get-Content -LiteralPath $profileManifestPath -Raw | ConvertFrom-Json
if ($null -eq $profileManifest.dsh -or $null -eq $profileManifest.dsh.profile) {
  throw "profile package.json has no dsh.profile section: $profileManifestPath"
}
$bundles = @($profileManifest.dsh.profile.bundles)
if ($bundles -notcontains $packageName) {
  $profileManifest.dsh.profile.bundles = @($bundles + $packageName)
  $profileManifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $profileManifestPath -Encoding utf8
  Write-Host "selected bundle: $packageName (added to dsh.profile.bundles)"
}
else {
  Write-Host "selected bundle: $packageName (already in dsh.profile.bundles)"
}

# A pre-bundle install wired the row with a hand-written profile patch; that
# insert would now insert the row twice.
$profilePatchPath = Join-Path $Profile 'cordis.patch.yml'
if (Test-Path -LiteralPath $profilePatchPath -PathType Leaf) {
  if (Select-String -LiteralPath $profilePatchPath -Pattern "name:\s*['`"]?$([regex]::Escape($packageName))['`"]?\s*$" -Quiet) {
    Write-Warning "legacy insert found in $profilePatchPath - remove it, the bundle patch inserts the row now."
  }
}

Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Restart DeepSeek Harness so the bundle layer and the tools load.'
Write-Host '  2. Sidebar > Plugins lists dsh-visual-explainer with a switch.'
Write-Host '  3. Ask the model for a 图解/可视化讲解; the visual_* tools should be available.'
Write-Host '  4. Check %TEMP%\dsh-visual-explainer-status.json for the live plugin version.'
