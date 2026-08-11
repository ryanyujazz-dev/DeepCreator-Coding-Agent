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
$runtimeProbe = 'const { DatabaseSync } = require("node:sqlite"); const database = new DatabaseSync(":memory:"); database.exec("SELECT 1"); database.close(); process.stdout.write("DEEPCREATOR_INSTALLED_READY")'
$runtimeOutput = & $installedExecutable.FullName -e $runtimeProbe
$runtimeExitCode = $LASTEXITCODE
if ($null -eq $previousElectronRunAsNode) {
  Remove-Item Env:ELECTRON_RUN_AS_NODE
} else {
  $env:ELECTRON_RUN_AS_NODE = $previousElectronRunAsNode
}
if ($runtimeExitCode -ne 0 -or ($runtimeOutput -join "") -notmatch "DEEPCREATOR_INSTALLED_READY") {
  Write-SquirrelLogs
  throw "安装后的 DeepCreator Runtime 验证失败，退出码：$runtimeExitCode。"
}

Write-Host "Windows 安装器实装成功：$($installedExecutable.FullName)"
