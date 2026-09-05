# Kairos 风扇守护：以管理员身份轮询 Lenovo GameZone WMI（拯救者 EC 风扇转速）
# 每秒输出一行 JSON：{"fan1": RPM, "fan2": RPM}
while ($true) {
  try {
    $gz = Get-WmiObject -Namespace root/WMI -Class LENOVO_GAMEZONE_DATA
    $f1 = $gz.GetFan1Speed(0)
    $f2 = $gz.GetFan2Speed(0)
    [PSCustomObject]@{ fan1 = [int]$f1; fan2 = [int]$f2 } | ConvertTo-Json -Compress
  } catch { '{"fan1": 0, "fan2": 0}' }
  Start-Sleep -Milliseconds 1000
}
