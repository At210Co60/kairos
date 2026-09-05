# Kairos — 液态玻璃桌面助手

Kairos 是一个 Windows 桌面悬浮助手:以"液态玻璃"质感的卡片网格呈现天气、音乐、系统硬件监控、剪贴板历史、番茄钟与翻译,点击卡片以 GSAP FLIP 动画全屏展开。桌面数据采集由 Electron 后端完成,纯浏览器预览时可运行 UI(系统数据仅在桌面环境下可用)。

## 功能模块

| 模块 | 说明 |
|---|---|
| 天气 | 自动定位,实时温度 / 多日预报 / 空气质量 |
| 音乐 | 正在播放控制、歌词、QQ 音乐搜索与播放 |
| 系统监控 | 1s 实时刷新:CPU 占用 / 频率 / 温度 / 风扇、内存、磁盘(按物理盘分组的容量 / 忙碌 / 温度)、GPU 占用 / 温度 / 风扇 / 显存 / 核心与显存频率、网络上下行 |
| 剪贴板 | 历史记录与快速回填 |
| 番茄钟 | 专注计时 |
| 翻译 | 文本翻译 |

## 技术栈

- 前端:React 19 + TypeScript + Vite,GSAP(FLIP 展开动画、3D 卡片悬停)
- 桌面壳:Electron(透明无边框窗口,IPC 与原生 Tauri API 签名一致,可平滑切换);`src-tauri/` 保留 Tauri 版本
- 硬件数据:systeminformation + LibreHardwareMonitor(WMI 流)+ Lenovo GameZone WMI(拯救者 EC 风扇)+ nvidia-smi(常驻轮询)+ PowerShell 性能计数器

## 快速开始

```bash
npm install

# 仅浏览器 UI 预览(无系统数据)
npm run dev

# Electron 开发模式(vite + electron 并行)
npm run electron:dev

# 构建并启动桌面应用(生产模式自动以管理员权限重启以读取硬件传感器)
npm run start
```

## 项目结构

```
src/
  App.tsx             # 卡片网格主界面(模块面板 + GSAP 动画)
  modules/            # 各功能面板(天气 / 系统监控 / 剪贴板 / 番茄钟 / 翻译)
  lib/tauri.ts        # 桌面桥 shim(Electron preload ↔ 面板)
  useNowPlaying.ts    # 当前播放(系统媒体会话)
electron/
  main.cjs            # 主进程:窗口、IPC、提权重启、LHM 守护
  preload.cjs         # 上下文隔离桥(window.kairos)
  backend/            # systemStats / weather / music / lyrics / perf
  vendor/             # 捆绑的 LibreHardwareMonitor 便携版
```

## 硬件监控说明

- 风扇 / CPU 温度等传感器需要管理员权限(Lenovo GameZone EC、磁盘温度等数据源在非提权进程下不可用);生产模式启动时会自动请求提权重启。
- LibreHardwareMonitor 以捆绑便携版运行于 `electron/vendor/`,也可通过 `setup-lhm.ps1` 注册开机自启的计划任务。
- 未安装对应数据源或权限不足时,相应传感器显示 `—`,不影响其余功能。
