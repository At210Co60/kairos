import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import gsap from 'gsap'
import { Flip } from 'gsap/Flip'
import { useGSAP } from '@gsap/react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import MusicPanel from './MusicPanel'
import ClipboardPanel from './modules/ClipboardPanel'
import PomodoroPanel from './modules/PomodoroPanel'
import WeatherPanel from './modules/WeatherPanel'
import TranslatePanel from './modules/TranslatePanel'
import SystemPanel from './modules/SystemPanel'
import { useNowPlaying } from './useNowPlaying'
import './App.css'

/**
 * Kairos 主界面：多模块卡片网格（参考图布局）。
 * 每个模块是独立组件（modules/ 目录），互不干扰；
 * 新增模块 = 写一个 Panel + 在网格里加一张卡片。
 * 点击卡片全屏展开（卡片保持挂载，番茄钟/播放不中断），左上角返回键或 Esc 收起。
 */

/** 各模块卡片的悬停倾斜句柄（展开时需清除，避免 FLIP 从 3D 悬停状态起步） */
const cardTiltMap = new WeakMap<
  HTMLElement,
  { rx: (v: number) => void; ry: (v: number) => void; mx: (v: number) => void; my: (v: number) => void }
>()

/** 可展开的模块卡片：点击进入全屏（FLIP 从原网格位形渐进补间），展开时头部渲染返回键 */
function ModuleCard({
  id,
  title,
  expanded,
  onExpand,
  onCollapse,
  headExtra,
  children,
}: {
  id: string
  title: string
  expanded: string | null
  onExpand: (id: string) => void
  onCollapse: () => void
  headExtra?: ReactNode
  children: ReactNode
}) {
  const isExpanded = expanded === id
  const cardRef = useRef<HTMLElement | null>(null)
  const flipState = useRef<ReturnType<typeof Flip.getState> | null>(null)
  const hiddenOthersRef = useRef<HTMLElement[]>([])

  const handleClick = (e: MouseEvent<HTMLElement>) => {
    if (expanded) return
    // 卡片内的输入框/按钮等控件点击不触发展开
    if ((e.target as HTMLElement).closest('input, textarea, select, button, a, label')) return
    const el = cardRef.current
    if (el) {
      // 抹平悬停遗留的 3D 倾斜/上浮，保证 FLIP 从平面网格位形起步
      gsap.killTweensOf(el)
      gsap.set(el, { clearProps: 'transform' })
      cardTiltMap.delete(el)
      flipState.current = Flip.getState(el)
    }
    onExpand(id)
  }

  const handleClose = () => {
    const el = cardRef.current
    if (el) {
      // 隐藏卡片列表必须在 class 移除「前」采集，否则收起后查不到
      hiddenOthersRef.current = Array.from(document.querySelectorAll<HTMLElement>('.module-card.card-hidden'))
      flipState.current = Flip.getState(el)
      el.classList.add('card-flipping')
    }
    onCollapse()
  }

  // 展开：位形渐进补间；收起：内容先淡出、卡片以纯变换缩回（无重排），落位后内容再淡入
  useLayoutEffect(() => {
    const el = cardRef.current
    const state = flipState.current
    if (!el || !state) return
    flipState.current = null
    if (isExpanded) {
      Flip.from(state, { duration: 0.6, ease: 'power3.inOut' })
      return
    }
    el.classList.add('card-flipping')
    const panel = el.querySelector('.panel-stack')
    if (panel) gsap.to(panel, { opacity: 0, duration: 0.16, ease: 'power1.out' })
    Flip.from(state, {
      duration: 0.55,
      ease: 'power2.inOut',
      scale: true,
      onComplete: () => {
        el.classList.remove('card-flipping')
        if (panel) gsap.fromTo(panel, { opacity: 0 }, { opacity: 1, duration: 0.28, ease: 'power1.out' })
      },
    })
    const others = hiddenOthersRef.current
    if (others.length) {
      gsap.fromTo(
        others,
        { opacity: 0, y: 14 },
        {
          opacity: 1,
          y: 0,
          duration: 0.5,
          stagger: 0.06,
          delay: 0.1,
          ease: 'power2.out',
          clearProps: 'opacity,transform',
        },
      )
    }
  }, [isExpanded])

  return (
    <section
      ref={cardRef}
      className={`module-card area-${id}${isExpanded ? ' card-expanded' : ''}${
        expanded && !isExpanded ? ' card-hidden' : ''
      }`}
      onClick={handleClick}
    >
      <header className="module-head">
        {isExpanded && (
          <button className="module-back" onClick={handleClose}>
            ‹ 返回
          </button>
        )}
        <p className="module-title">{title}</p>
        {headExtra}
      </header>
      {children}
    </section>
  )
}

function App() {
  gsap.registerPlugin(useGSAP, Flip)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const { meta, progress, lyrics, lyricsState } = useNowPlaying()

  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  // GSAP 悬停动效：事件委托统一接管，动态挂载的面板内容无需单独绑定。
  // 模块卡 = 聚光灯跟随 + 3° 视差倾斜 + 上浮；小卡片 = 上浮；按钮 = 放大。
  useGSAP(
    () => {
      const CARD_SEL = '.module-card:not(.card-expanded)'
      const LIFT_SEL = '.wd-card, .glass-card'
      const BTN_SEL = '.tr-btn, .win-btn, .module-back, .wd-toggle button, .tr-swap'

      const bindCard = (card: HTMLElement) => {
        if (cardTiltMap.has(card)) return
        gsap.set(card, { transformPerspective: 900, '--mx': '50%', '--my': '24%' })
        cardTiltMap.set(card, {
          rx: gsap.quickTo(card, 'rotationX', { duration: 0.5, ease: 'power3.out' }),
          ry: gsap.quickTo(card, 'rotationY', { duration: 0.5, ease: 'power3.out' }),
          mx: gsap.quickTo(card, '--mx', { duration: 0.35, ease: 'power2.out' }),
          my: gsap.quickTo(card, '--my', { duration: 0.35, ease: 'power2.out' }),
        })
      }

      const onOver = (e: PointerEvent) => {
        if (e.pointerType !== 'mouse') return
        const target = e.target as HTMLElement | null
        const related = e.relatedTarget as Node | null
        const card = target?.closest<HTMLElement>(CARD_SEL)
        // 翻转中的卡片不参与悬停动效，避免与 FLIP 打架
        if (card?.classList.contains('card-flipping')) return
        if (card && !card.contains(related)) {
          bindCard(card)
          gsap.to(card, { y: -4, duration: 0.4, ease: 'power3.out' })
        }
        const lift = target?.closest<HTMLElement>(LIFT_SEL)
        if (lift && !lift.contains(related)) {
          gsap.to(lift, { y: -2, duration: 0.28, ease: 'power2.out' })
        }
        const btn = target?.closest<HTMLElement>(BTN_SEL)
        if (btn && !btn.contains(related)) {
          gsap.to(btn, { scale: 1.07, duration: 0.22, ease: 'power2.out' })
        }
      }

      const onMove = (e: PointerEvent) => {
        if (e.pointerType !== 'mouse') return
        const card = (e.target as HTMLElement | null)?.closest<HTMLElement>(CARD_SEL)
        if (card?.classList.contains('card-flipping')) return
        const tilt = card && cardTiltMap.get(card)
        if (card && tilt) {
          const r = card.getBoundingClientRect()
          const px = (e.clientX - r.left) / r.width
          const py = (e.clientY - r.top) / r.height
          tilt.ry((px - 0.5) * 5)
          tilt.rx((0.5 - py) * 5)
          tilt.mx(px * 100)
          tilt.my(py * 100)
        }
      }

      const onOut = (e: PointerEvent) => {
        if (e.pointerType !== 'mouse') return
        const target = e.target as HTMLElement | null
        const related = e.relatedTarget as Node | null
        const card = target?.closest<HTMLElement>(CARD_SEL)
        const tilt = card && cardTiltMap.get(card)
        if (card && tilt && !card.contains(related)) {
          tilt.rx(0)
          tilt.ry(0)
          gsap.to(card, { y: 0, duration: 0.5, ease: 'power3.out' })
        }
        const lift = target?.closest<HTMLElement>(LIFT_SEL)
        if (lift && !lift.contains(related)) {
          gsap.to(lift, { y: 0, duration: 0.35, ease: 'power2.out' })
        }
        const btn = target?.closest<HTMLElement>(BTN_SEL)
        if (btn && !btn.contains(related)) {
          gsap.to(btn, { scale: 1, duration: 0.3, ease: 'power2.out' })
        }
      }

      window.addEventListener('pointerover', onOver)
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerout', onOut)
      return () => {
        window.removeEventListener('pointerover', onOver)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerout', onOut)
      }
    },
    { revertOnUpdate: false },
  )

  const collapse = () => setExpanded(null)

  return (
    <div ref={rootRef} className="kairos-root">
      {/* 全局 audio：模块切换不打断播放 */}
      <audio ref={audioRef} />
      {/* 液态玻璃折射滤镜：卡片 backdrop-filter 引用，让背后光斑发生真实扭曲 */}
      <svg className="lg-defs" aria-hidden>
        <defs>
          <filter
            id="kairos-refract"
            x="-20%"
            y="-20%"
            width="140%"
            height="140%"
            colorInterpolationFilters="sRGB"
          >
            <feTurbulence type="fractalNoise" baseFrequency="0.009 0.013" numOctaves="2" seed="11" result="noise" />
            <feGaussianBlur in="noise" stdDeviation="3.2" result="soft" />
            <feDisplacementMap in="SourceGraphic" in2="soft" scale="52" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
      </svg>
      <div className="orb orb-violet" />
      <div className="orb orb-blue" />
      <div className="orb orb-cyan" />

      <header className="kairos-titlebar" data-tauri-drag-region>
        <span className="kairos-titlebar-name">Kairos · 液态玻璃桌面助手</span>
        <div className="win-controls">
          <button
            className="win-btn"
            onClick={() => getCurrentWindow().minimize()}
            title="最小化"
          >
            —
          </button>
          <button
            className="win-btn close"
            onClick={() => getCurrentWindow().close()}
            title="退出 Kairos"
          >
            ✕
          </button>
        </div>
      </header>

      <main className="modules-grid">
        <ModuleCard
          id="clip"
          title="剪贴板历史"
          expanded={expanded}
          onExpand={setExpanded}
          onCollapse={collapse}
          headExtra={<span className="module-more">⋮</span>}
        >
          <ClipboardPanel />
        </ModuleCard>

        <ModuleCard
          id="pomo"
          title="番茄钟"
          expanded={expanded}
          onExpand={setExpanded}
          onCollapse={collapse}
          headExtra={<span className="module-more">⚙</span>}
        >
          <PomodoroPanel />
        </ModuleCard>

        <ModuleCard
          id="weather"
          title="天气"
          expanded={expanded}
          onExpand={setExpanded}
          onCollapse={collapse}
          headExtra={<span className="module-more">⟳</span>}
        >
          <WeatherPanel expanded={expanded === 'weather'} />
        </ModuleCard>

        <ModuleCard
          id="music"
          title="音乐"
          expanded={expanded}
          onExpand={setExpanded}
          onCollapse={collapse}
          headExtra={meta?.playing ? <span className="module-playing">正在播放</span> : null}
        >
          <MusicPanel
            meta={meta}
            progress={progress}
            lyrics={lyrics}
            lyricsState={lyricsState}
            audioRef={audioRef}
          />
        </ModuleCard>

        <ModuleCard
          id="translate"
          title="翻译"
          expanded={expanded}
          onExpand={setExpanded}
          onCollapse={collapse}
          headExtra={<span className="module-more">⇄</span>}
        >
          <TranslatePanel />
        </ModuleCard>

        <ModuleCard
          id="system"
          title="系统监控"
          expanded={expanded}
          onExpand={setExpanded}
          onCollapse={collapse}
          headExtra={<span className="module-more">📊</span>}
        >
          <SystemPanel />
        </ModuleCard>
      </main>
    </div>
  )
}

export default App
