param(
  [string]$SetupPath = ""
)

$ErrorActionPreference = "Stop"

function Write-SquirrelLogs {
  $candidateRoots = @(
    (Join-Path $env:LOCALAPPDATA "SquirrelTemp/SquirrelSetup.log"),
    (Join-Path $env:LOCALAPPDATA "SquirrelTemp"),
    (Join-Path $env:LOCALAPPDATA "deepcreator")
  )

  foreach ($candidateRoot in $candidateRoots) {
    if (-not (Test-Path $candidateRoot)) {
      continue
    }

    if ((Get-Item $candidateRoot).PSIsContainer -eq $false) {
      Write-Host "Squirrel log: $candidateRoot"
      Get-Content $candidateRoot -Tail 160 -ErrorAction SilentlyContinue
      continue
    }

    Get-ChildItem -Path $candidateRoot -Filter "*.log" -File -Recurse -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 4 |
      ForEach-Object {
        Write-Host "Squirrel log: $($_.FullName)"
        Get-Content $_.FullName -Tail 160 -ErrorAction SilentlyContinue
      }
  }
}

function Write-StartupDiagnostics {
  param(
    [string]$ProbePath,
    [string]$StdoutPath,
    [string]$StderrPath,
    [System.Diagnostics.Process]$ApplicationProcess
  )

  Write-Host "DeepCreator startup process: pid=$($ApplicationProcess.Id), exited=$($ApplicationProcess.HasExited)"
  foreach ($entry in @(
    @{ Label = "Startup probe"; Path = $ProbePath },
    @{ Label = "Startup stdout"; Path = $StdoutPath },
    @{ Label = "Startup stderr"; Path = $StderrPath }
  )) {
    Write-Host "$($entry.Label): $($entry.Path)"
    if (Test-Path $entry.Path) {
      Get-Content $entry.Path -Tail 200 -ErrorAction SilentlyContinue
    } else {
      Write-Host "<missing>"
    }
  }
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq "DeepCreator.exe" } |
    Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine |
    Format-List |
    Out-String |
    Write-Host
}

if ([string]::IsNullOrWhiteSpace($SetupPath)) {
  $setup = Get-ChildItem -Path "out/make" -Filter "DeepCreator-Setup.exe" -File -Recurse |
    Select-Object -First 1
  if ($null -eq $setup) {
    throw "没有找到 out/make 下的 DeepCreator-Setup.exe。"
  }
  $SetupPath = $setup.FullName
}

$resolvedSetupPath = (Resolve-Path $SetupPath).Path
$portableArchive = Get-ChildItem -Path "out/make" -Filter "*.zip" -File -Recurse |
  Where-Object { $_.FullName -match "win32" } |
  Select-Object -First 1
if ($null -eq $portableArchive) {
  throw "Windows Release 缺少免安装 ZIP。"
}

$installRoot = Join-Path $env:LOCALAPPDATA "deepcreator"
if (Test-Path $installRoot) {
  throw "Windows Runner 不是干净安装环境：$installRoot 已存在。"
}

Write-Host "正在执行 Windows 安装器：$resolvedSetupPath"
$installer = Start-Process -FilePath $resolvedSetupPath -ArgumentList "--silent" -PassThru
if (-not $installer.WaitForExit(120000)) {
  $installer.Kill()
  Write-SquirrelLogs
  throw "Windows 安装器在 120 秒内没有结束。"
}
if ($installer.ExitCode -ne 0) {
  Write-SquirrelLogs
  throw "Windows 安装器失败，退出码：$($installer.ExitCode)。"
}

$installedExecutable = $null
$installDeadline = (Get-Date).AddSeconds(120)
while ($null -eq $installedExecutable -and (Get-Date) -lt $installDeadline) {
  if (Test-Path $installRoot) {
    $installedExecutable = Get-ChildItem -Path $installRoot -Filter "DeepCreator.exe" -File -Recurse |
      Where-Object { $_.Directory.Name -like "app-*" } |
      Sort-Object FullName -Descending |
      Select-Object -First 1
  }
  if ($null -eq $installedExecutable) {
    Start-Sleep -Milliseconds 500
  }
}
if ($null -eq $installedExecutable) {
  Write-SquirrelLogs
  throw "安装器返回成功，但没有在 $installRoot 找到 DeepCreator.exe。"
}

$previousElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE
$env:ELECTRON_RUN_AS_NODE = "1"
$runtimeProbePath = Join-Path $env:RUNNER_TEMP "deepcreator-installed-runtime-probe.cjs"
$runtimeStdoutPath = Join-Path $env:RUNNER_TEMP "deepcreator-installed-runtime-stdout.log"
$runtimeStderrPath = Join-Path $env:RUNNER_TEMP "deepcreator-installed-runtime-stderr.log"
$runtimeProbe = 'const { DatabaseSync } = require("node:sqlite"); const database = new DatabaseSync(":memory:"); database.exec("SELECT 1"); database.close(); process.stdout.write("DEEPCREATOR_INSTALLED_READY")'
[IO.File]::WriteAllText($runtimeProbePath, $runtimeProbe)
$runtimeProcess = Start-Process `
  -FilePath $installedExecutable.FullName `
  -ArgumentList $runtimeProbePath `
  -RedirectStandardOutput $runtimeStdoutPath `
  -RedirectStandardError $runtimeStderrPath `
  -PassThru
if (-not $runtimeProcess.WaitForExit(30000)) {
  $runtimeProcess.Kill()
  throw "安装后的 DeepCreator Runtime 在 30 秒内没有结束。"
}
$runtimeExitCode = $runtimeProcess.ExitCode
$runtimeOutput = Get-Content $runtimeStdoutPath -Raw -ErrorAction SilentlyContinue
$runtimeError = Get-Content $runtimeStderrPath -Raw -ErrorAction SilentlyContinue
if ($null -eq $previousElectronRunAsNode) {
  Remove-Item Env:ELECTRON_RUN_AS_NODE
} else {
  $env:ELECTRON_RUN_AS_NODE = $previousElectronRunAsNode
}
if ($runtimeExitCode -ne 0 -or ($runtimeOutput -join "") -notmatch "DEEPCREATOR_INSTALLED_READY") {
  Write-SquirrelLogs
  throw "安装后的 DeepCreator Runtime 验证失败，退出码：$runtimeExitCode。$runtimeError"
}

$startupProbePath = Join-Path $env:RUNNER_TEMP "deepcreator-startup-probe.json"
$startupStdoutPath = Join-Path $env:RUNNER_TEMP "deepcreator-startup-stdout.log"
$startupStderrPath = Join-Path $env:RUNNER_TEMP "deepcreator-startup-stderr.log"
$env:DEEPCREATOR_STARTUP_PROBE_FILE = $startupProbePath
$applicationProcess = Start-Process `
  -FilePath $installedExecutable.FullName `
  -RedirectStandardOutput $startupStdoutPath `
  -RedirectStandardError $startupStderrPath `
  -PassThru
if (-not $applicationProcess.WaitForExit(60000)) {
  Write-StartupDiagnostics `
    -ProbePath $startupProbePath `
    -StdoutPath $startupStdoutPath `
    -StderrPath $startupStderrPath `
    -ApplicationProcess $applicationProcess
  $applicationProcess.Kill()
  throw "安装后的 DeepCreator 在 60 秒内没有完成真实启动验证。"
}
Remove-Item Env:DEEPCREATOR_STARTUP_PROBE_FILE
$startupOutput = Get-Content $startupStdoutPath -Raw -ErrorAction SilentlyContinue
$startupError = Get-Content $startupStderrPath -Raw -ErrorAction SilentlyContinue
if (-not (Test-Path $startupProbePath)) {
  throw "DeepCreator 没有写入真实启动结果。`n$startupOutput`n$startupError"
}
$startupResult = Get-Content $startupProbePath -Raw | ConvertFrom-Json
if ($applicationProcess.ExitCode -ne 0 -or $startupResult.runtime.phase -ne "ready" -or $startupResult.auth.phase -ne "signed_in") {
  throw "DeepCreator 真实启动失败：$($startupResult | ConvertTo-Json -Depth 8 -Compress)`n$startupOutput`n$startupError"
}

Write-Host "Windows 安装器、应用主进程与 Agent Runtime 实装成功：$($installedExecutable.FullName)"
