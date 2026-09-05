$gz = Get-WmiObject -Namespace root/WMI -Class LENOVO_GAMEZONE_DATA
@{
  cpuTemp = $gz.GetCPUTemp(0)
  gpuTemp = $gz.GetGPUTemp(0)
  fan1 = $gz.GetFan1Speed(0)
  fan2 = $gz.GetFan2Speed(0)
  freq = $gz.GetCpuFrequency(0)
} | ConvertTo-Json | Out-File 'C:\Users\15271\Desktop\kairos\lenovo-test.json' -Encoding utf8
