import { useEffect, useRef, useState } from 'react'

/**
 * 番茄钟模块（可用的雏形）
 * 25 分钟专注 + 圆环进度，纯前端逻辑；
 * 完成计数、音效提醒后续接入。
 */

const FOCUS_SECONDS = 25 * 60

export default function PomodoroPanel() {
  const [remain, setRemain] = useState(FOCUS_SECONDS)
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(3)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!running) return
    timer.current = window.setInterval(() => {
      setRemain((r) => {
        if (r <= 1) {
          setRunning(false)
          setDone((d) => d + 1)
          return FOCUS_SECONDS
        }
        return r - 1
      })
    }, 1000)
    return () => window.clearInterval(timer.current)
  }, [running])

  const mm = String(Math.floor(remain / 60)).padStart(2, '0')
  const ss = String(remain % 60).padStart(2, '0')
  const progress = 1 - remain / FOCUS_SECONDS
  // 圆环参数
  const R = 78
  const C = 2 * Math.PI * R

  return (
    <div className="panel-stack pomodoro">
      <svg className="pomo-ring" viewBox="0 0 200 200">
        <circle cx="100" cy="100" r={R} className="ring-bg" />
        <circle
          cx="100"
          cy="100"
          r={R}
          className="ring-fg"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - progress)}
          transform="rotate(-90 100 100)"
        />
      </svg>
      <div className="pomo-center">
        <p className="pomo-time">{mm}:{ss}</p>
        <p className="pomo-label">{running ? '专注中' : '专注时间'}</p>
      </div>
      <div className="pomo-controls">
        <button
          className={`pomo-main ${running ? 'running' : ''}`}
          onClick={() => setRunning(!running)}
        >
          {running ? '❚❚' : '▶'}
        </button>
        <button
          className="pomo-reset"
          onClick={() => {
            setRunning(false)
            setRemain(FOCUS_SECONDS)
          }}
        >
          ⟲
        </button>
      </div>
      <p className="pomo-done">已完成 <b>{done}</b> / 8 个番茄</p>
    </div>
  )
}
