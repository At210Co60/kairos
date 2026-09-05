# 创建 LHM 计划任务（开机自动 + 最高权限）
schtasks /create /tn "Kairos\LibreHardwareMonitor" /tr "C:\Tools\LibreHardwareMonitor\LibreHardwareMonitor.exe /minimized" /sc onlogon /rl highest /f
# 立即启动
Start-Process 'C:\Tools\LibreHardwareMonitor\LibreHardwareMonitor.exe' -WorkingDirectory 'C:\Tools\LibreHardwareMonitor'
# 验证
Start-Sleep -Seconds 3
$sensor = Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Sensor -ErrorAction SilentlyContinue | Measure-Object
Write-Output ("LHM_SENSORS: " + $sensor.Count)
