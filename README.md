# Kairos · 液态玻璃桌面助手

> 一个常驻 Windows 桌面的悬浮助手。天气、音乐、硬件监控、剪贴板、番茄钟、翻译以卡片网格排布，
> 点开任意卡片即以 GSAP FLIP 动画全屏展开；界面背景由一层**自研 WebGL 着色器做真实折射**的液态玻璃绘制。

[![Platform](https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D6?style=flat-square&logo=windows11&logoColor=white)](#)
[![Electron](https://img.shields.io/badge/Electron-44-47848F?style=flat-square&logo=electron&logoColor=white)](#)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](#)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?style=flat-square&logo=typescript&logoColor=white)](#)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white)](#)

Kairos 分成两部分：React 前端负责全部界面与动画，Electron 主进程负责窗口、权限以及硬件与网络
数据采集。前端通过 `src/lib/tauri.ts` 这层薄桥与后端通信，桥的方法签名与原生 Tauri 保持一致，
所以纯浏览器预览和桌面运行可以共用同一套面板代码。

## 功能模块

| 模块 | 说明 |
|---|---|
| 天气 | 自动定位，实时温度 / 多日预报 / 空气质量 |
| 音乐 | 正在播放控制、歌词滚动、QQ 音乐搜索与播放 |
| 系统监控 | 1s 实时刷新。按 **CPU / 内存 / 磁盘 / 显卡 / 网络** 拆成五张卡片，卡头显示 CPU 型号、内存规格（如 `DDR5-5600 · 2×16GB`）、显卡短名；占用率用水箱水位与 270° 仪表盘指针呈现 |
| 剪贴板 | 历史记录与快速回填 |
| 番茄钟 | 可配置时长（1–180 分钟，预设 15/25/45/60），暂停与中止需填写原因，每轮结束记录成条（最多 50 条）并发送桌面通知 |
| 翻译 | 文本翻译 |

### 系统监控的数据粒度

- **CPU**：占用率、频率、温度、风扇转速
- **内存**：用量、频率
- **磁盘**：按物理盘分组——父级给出容量合计 / 忙碌% / 温度，子级展开为该盘下各分区卷的用量，呈现为 `物理盘 → 分区` 两级水位
- **显卡**：占用率、温度、风扇、显存、核心与显存频率（nvidia-smi 常驻轮询）
- **网络**：上下行速率，仪表量程按本次会话峰值自动升档

## 液态玻璃是怎么做的

Chromium 里没有任何 CSS 手段能弯折背景——`backdrop-filter` 只会模糊，SVG 滤镜式的
"真折射"在 Chromium 上不可用。所以这一层是真的写着色器逐像素算出来的，实现见
[`src/lib/desktopGlass.ts`](src/lib/desktopGlass.ts)：

1. 先建立壁纸到屏幕的 `cover` 映射，再叠加窗口在屏幕上的偏移，使**窗口内看到的背景与桌面上
   同一位置的壁纸对齐**；窗口移动或缩放时通过 IPC 重算映射。
2. 再对每个 `.module-card` 的圆角矩形跑玻璃着色器：

   | 效果 | 做法 |
   |---|---|
   | 倒角折射 | 对圆角矩形 SDF 求梯度得到边缘法线，采样点沿法线向内推，越靠边缘越强 |
   | 色散 | R / B 通道沿法线朝相反方向错开采样 |
   | 镜面高光 | 高光跟随鼠标，另加一道固定顶光 |
   | 面板色调 | 从 CSS 变量 `--glass-tint` / `--glass-tint-alpha` 读取，方便调参 |
   | 面板外投影 | 只在 SDF 之外输出压暗的 alpha，避免整屏四边形互相覆盖 |

3. 接管成功后给 `<body>` 加上 `glass-live`，CSS 随即把卡片的背景 / 边框 / 模糊让位给这一层。

**降级路径**：拿不到 WebGL 上下文或壁纸加载失败时 `startDesktopGlass()` 会抛错，`App.tsx`
捕获后保持原样，界面自动退回纯 CSS 玻璃，功能不受影响。

## 技术栈

- **前端**：React 19 + TypeScript + Vite，GSAP（FLIP 展开动画、3D 卡片悬停视差）
- **桌面壳**：Electron。无边框窗口，且 `transparent: false`——玻璃效果完全由页面内的 WebGL 层
  绘制，不依赖 DWM 亚克力；`backgroundThrottling: false` 让窗口在后台时番茄钟与轮询照常运行
- **硬件数据**：systeminformation + LibreHardwareMonitor（WMI 流）+ Lenovo GameZone WMI
  （拯救者 EC 风扇）+ nvidia-smi + PowerShell 性能计数器
- **`src-tauri/`** 保留了同一套前端的 Tauri 版本，可平滑切换

## 快速开始

需要 Node.js 20.19+（本项目在 Node 24 上开发）。

```bash
npm install

# 仅浏览器 UI 预览：布局与动画可用，系统 / 天气 / 音乐等桌面数据不可用
npm run dev

# Electron 开发模式（vite 与 electron 并行）
npm run electron:dev

# 构建并启动桌面应用
npm run start
```

### 关于管理员权限

读取风扇转速、CPU / 磁盘温度等传感器需要管理员权限。Kairos 的做法是**只在第一次弹一次 UAC**：

1. 首次以普通权限启动时，注册一个名为 `Kairos\ElevatedLaunch` 的计划任务
   （`RunLevel Highest`、无触发器、仅按需拉起），随后请求提权重启一次；
2. 此后只要该任务已存在，启动时直接 `schtasks /run` 静默拉起提权实例、当前实例退出，
   不再反复弹 UAC；
3. `npm run electron:dev` 开发模式本身不提权（便于调试前端），但会为
   LibreHardwareMonitor 单独请求一次 UAC。

## 项目结构

```
src/
  App.tsx             # 卡片网格主界面（模块面板 + GSAP 动画 + 折射层挂载）
  App.css             # 全量样式，含 body.glass-live 下的让位规则
  MusicPanel.tsx      # 音乐面板（其余面板在 modules/）
  useNowPlaying.ts    # 当前播放（系统媒体会话）
  modules/            # 天气 / 系统监控 / 剪贴板 / 番茄钟 / 翻译
  lib/
    desktopGlass.ts   # WebGL 液态玻璃折射层
    tauri.ts          # 桌面桥 shim（Electron preload ↔ 面板）
  assets/             # 壁纸等静态资源
electron/
  main.cjs            # 主进程：窗口、IPC、提权计划任务、LHM 守护
  preload.cjs         # 上下文隔离桥（window.kairos）
  backend/            # systemStats / weather / music / lyrics / perf
  vendor/             # 捆绑的 LibreHardwareMonitor 便携版
src-tauri/            # 保留的 Tauri 版本
```

## 硬件监控说明

- 捆绑的 LibreHardwareMonitor 以 `/minimized` 启动于 `electron/vendor/LibreHardwareMonitor/`。
  启动前会先探测 WMI 命名空间，已有传感器实例则跳过；由 Kairos 拉起的实例会在应用退出时一并结束。
- **未安装对应数据源或权限不足时，相应传感器显示 `—`，不影响其余功能。**
- LibreHardwareMonitor 的配置文件（`LibreHardwareMonitor.config`）**不入库**：整个文件都是 LHM
  运行时写回的逐传感器状态与本机网卡 / 电池数据，缺失时 LHM 会在首次运行自动生成默认配置。

## 已知限制

- **副屏偏移**：折射层按主显示器尺寸计算壁纸映射，窗口被拖到副屏时背景采样会对不上。
- **浏览器预览不完整**：`npm run dev` 下没有桌面桥，系统监控、天气、音乐等面板会显示占位或提示，
  这是预期行为，完整效果需以 Electron 运行。
- 折射层每帧都会对每张卡片调用 `getBoundingClientRect()` / `getComputedStyle()` 以获取面板几何，
  卡片数量增长会线性抬高开销。
