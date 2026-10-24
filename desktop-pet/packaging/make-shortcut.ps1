# Create a desktop shortcut pointing at *this* copy of the pet.
#
# Kept in PowerShell with the file saved as UTF-8 with BOM, because Windows
# PowerShell 5.1 reads .ps1 files as ANSI without a BOM and the Chinese messages
# would come out as mojibake.
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $here 'electron.exe'

if (-not (Test-Path $exe)) {
  Write-Host '没找到 electron.exe。' -ForegroundColor Red
  Write-Host '请把这个脚本放在解压后的文件夹里（和 electron.exe、start-pet.cmd 同一层）。'
  exit 1
}

$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop -or -not (Test-Path $desktop)) {
  Write-Host '找不到桌面文件夹。' -ForegroundColor Red
  exit 1
}

$lnk = Join-Path $desktop 'Blob Pet 资讯桌宠.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnk)
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = $here
$shortcut.IconLocation = $exe
$shortcut.Description = '资讯筛选桌宠（免安装）'
$shortcut.Save()

Write-Host '已创建桌面快捷方式：' -ForegroundColor Green
Write-Host "  $lnk"
Write-Host ''
Write-Host '以后双击它就能启动桌宠。'
Write-Host '如果想换位置，直接把整个文件夹搬到别处，再跑一次这个脚本即可。'
Write-Host '（被搬走后旧快捷方式会失效，删掉它就行。）'
