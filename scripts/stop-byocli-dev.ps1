param(
  [string]$Workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [int]$ExcludePid = 0
)

$workspacePrefix = $Workspace.TrimEnd('\') + '\'
$all = @(Get-CimInstance Win32_Process)
$roots = @($all | Where-Object {
  if ($_.ProcessId -eq $ExcludePid) { return $false }
  $command = [string]$_.CommandLine
  $executable = [string]$_.ExecutablePath
  ($executable -like "$workspacePrefix*byocli.exe") -or
  ($executable -like "$workspacePrefix*relay-workspace.exe") -or
  ($command -like "*$workspacePrefix*node_modules*vite*bin*vite.js*") -or
  ($command -like "*$workspacePrefix*node_modules*@tauri-apps*cli*tauri.js*")
})

$targetIds = [System.Collections.Generic.HashSet[int]]::new()
$queue = [System.Collections.Generic.Queue[int]]::new()
foreach ($root in $roots) {
  if ($targetIds.Add([int]$root.ProcessId)) {
    $queue.Enqueue([int]$root.ProcessId)
  }
}

while ($queue.Count -gt 0) {
  $parentId = $queue.Dequeue()
  foreach ($child in $all | Where-Object { $_.ParentProcessId -eq $parentId }) {
    if ($child.ProcessId -ne $ExcludePid -and $targetIds.Add([int]$child.ProcessId)) {
      $queue.Enqueue([int]$child.ProcessId)
    }
  }
}

$targets = @($all | Where-Object { $targetIds.Contains([int]$_.ProcessId) })
foreach ($target in $targets | Sort-Object CreationDate -Descending) {
  Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue
}

if ($targets.Count -gt 0) {
  Write-Host "Stopped $($targets.Count) previous BYOCLI development process(es)."
}
