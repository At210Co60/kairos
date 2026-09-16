import { useEffect, useState } from 'react'
import { notify } from '../lib/tauri'

/**
 * 番茄钟模块
 * - 右上角 ⚙ 打开设置：专注时长 1..180 分钟（localStorage 持久化）
 * - 运行中暂停 / 结束本次都必须填写原因，且不能为空（原因为空时确认键置灰）
 * - 一轮结束（自然到点填"完成了什么"，中途结束填原因）在下方生成一条记录：
 *   时长 · 暂停次数 · 用途 / 中断原因（localStorage 持久化，最多保留 50 条）
 */

const MIN_MINUTES = 1
const MAX_MINUTES = 180
const PRESETS = [15, 25, 45, 60]
const MAX_RECORDS = 50
const LS_MINUTES = 'kairos.pomo.minutes'
const LS_RECORDS = 'kairos.pomo.records'

interface PomoRecord {
  id: string
  kind: 'done' | 'aborted'
  minutes: number // 本轮设定的专注时长（分钟）
  elapsedSec: number // 实际专注秒数（中途结束会小于设定值）
  pauses: number // 本轮暂停次数
  pauseReasons: string[] // 各次暂停的原因（列表里悬停可看）
  text: string // 用途（自然结束）/ 中断原因（中途结束）
  at: number // 完成时间戳
}

type PromptKind = 'pause' | 'exit' | 'done'

function loadMinutes(): number {
  try {
    const v = Math.round(Number(localStorage.getItem(LS_MINUTES)))
    if (Number.isFinite(v) && v >= MIN_MINUTES && v <= MAX_MINUTES) return v
  } catch {}
  return 25
}

function loadRecords(): PomoRecord[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LS_RECORDS) || '[]')
    if (Array.isArray(raw)) return raw as PomoRecord[]
  } catch {}
  return []
}

function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`
}

function fmtClock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const PROMPT_TEXT: Record<PromptKind, { title: string; hint: string; placeholder: string; ok: string }> = {
  pause: {
    title: '暂停原因',
    hint: '必须填写原因才能暂停',
    placeholder: '例如：被叫去开会 / 先去处理一件急事',
    ok: '确认暂停',
  },
  exit: {
    title: '结束本次番茄钟',
    hint: '中途结束必须填写原因，本轮会记为「中断」',
    placeholder: '例如：任务提前完成 / 被临时打断',
    ok: '确认结束',
  },
  done: {
    title: '这一轮完成了什么？',
    hint: '写一句留档，之后可在下方回看',
    placeholder: '例如：写完周报的数据部分',
    ok: '保存记录',
  },
}

export default function PomodoroPanel({
  settingsOpen,
  onCloseSettings,
}: {
  settingsOpen: boolean
  onCloseSettings: () => void
}) {
  const [minutes, setMinutes] = useState(loadMinutes) // 设置里的专注时长
  const [sessionMin, setSessionMin] = useState(loadMinutes) // 本轮生效时长
  const [remain, setRemain] = useState(() => loadMinutes() * 60) // 显示用剩余秒数
  const [anchorRemain, setAnchorRemain] = useState(() => loadMinutes() * 60) // 本段运行开始时的剩余秒数
  const [anchorAt, setAnchorAt] = useState(0) // 本段运行开始的时间戳
  const [running, setRunning] = useState(false)
  const [active, setActive] = useState(false) // 本轮是否进行中（含暂停）
  const [pauses, setPauses] = useState(0)
  const [pauseReasons, setPauseReasons] = useState<string[]>([])
  const [records, setRecords] = useState<PomoRecord[]>(loadRecords)
  const [prompt, setPrompt] = useState<PromptKind | null>(null)
  const [draft, setDraft] = useState('')
  const [draftMin, setDraftMin] = useState(() => String(loadMinutes())) // 设置里输入框的草稿值

  // 计时：以墙钟为准（不受休眠/节流影响），每 250ms 刷新显示
  useEffect(() => {
    if (!running) return
    const tick = () => {
      const rest = anchorRemain - Math.floor((Date.now() - anchorAt) / 1000)
      if (rest <= 0) {
        setRemain(0)
        setRunning(false)
        setDraft('')
        setPrompt('done')
        notify('番茄钟完成', '记录一下这一轮做了什么吧')
        return
      }
      setRemain(rest)
    }
    const t = window.setInterval(tick, 250)
    return () => window.clearInterval(t)
  }, [running, anchorRemain, anchorAt])

  // 持久化
  useEffect(() => {
    try {
      localStorage.setItem(LS_MINUTES, String(minutes))
    } catch {}
  }, [minutes])

  useEffect(() => {
    try {
      localStorage.setItem(LS_RECORDS, JSON.stringify(records))
    } catch {}
  }, [records])

  const mm = String(Math.floor(remain / 60)).padStart(2, '0')
  const ss = String(remain % 60).padStart(2, '0')
  const R = 78
  const C = 2 * Math.PI * R
  const progress = 1 - remain / (sessionMin * 60)

  const resetToIdle = () => {
    setActive(false)
    setRunning(false)
    setPauses(0)
    setPauseReasons([])
    setSessionMin(minutes)
    setRemain(minutes * 60)
    setAnchorRemain(minutes * 60)
  }

  const onMain = () => {
    if (!active) {
      // 开始新一轮
      setSessionMin(minutes)
      setRemain(minutes * 60)
      setAnchorRemain(minutes * 60)
      setAnchorAt(Date.now())
      setPauses(0)
      setPauseReasons([])
      setActive(true)
      setRunning(true)
      return
    }
    if (running) {
      // 暂停需填原因
      setDraft('')
      setPrompt('pause')
      return
    }
    // 从暂停恢复
    setAnchorRemain(remain)
    setAnchorAt(Date.now())
    setRunning(true)
  }

  const onEnd = () => {
    if (!active) return
    setDraft('')
    setPrompt('exit')
  }

  const onConfirm = () => {
    const text = draft.trim()
    if (!text || !prompt) return
    if (prompt === 'pause') {
      setPauses((n) => n + 1)
      setPauseReasons((a) => [...a, text])
      setRunning(false)
      setPrompt(null)
      return
    }
    const record: PomoRecord = {
      id: `${Date.now()}`,
      kind: prompt === 'done' ? 'done' : 'aborted',
      minutes: sessionMin,
      elapsedSec: prompt === 'done' ? sessionMin * 60 : sessionMin * 60 - remain,
      pauses,
      pauseReasons,
      text,
      at: Date.now(),
    }
    setRecords((list) => [record, ...list].slice(0, MAX_RECORDS))
    resetToIdle()
    setPrompt(null)
  }

  const applyMinutes = (raw: string) => {
    const t = raw.trim()
    if (!t) return
    const v = Math.round(Number(t))
    if (!Number.isFinite(v)) return
    const m = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, v))
    setMinutes(m)
    setDraftMin(String(m))
    if (!active) {
      setSessionMin(m)
      setRemain(m * 60)
      setAnchorRemain(m * 60)
    }
  }

  const promptText = prompt ? PROMPT_TEXT[prompt] : null

  return (
    <div className="panel-stack pomodoro">
      {/* 滚动区：圆环 + 时间 + 控制 + 记录（弹层固定在外，不随滚动位移） */}
      <div className="pomo-scroll">
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
          <p className="pomo-time">
            {mm}:{ss}
          </p>
          <p className="pomo-label">{running ? '专注中' : active ? '已暂停' : '专注时间'}</p>
        </div>
        <div className="pomo-controls">
          <button className={`pomo-main ${running ? 'running' : ''}`} onClick={onMain}>
            {running ? '❚❚' : '▶'}
          </button>
          <button className="pomo-reset" onClick={onEnd} disabled={!active} title="结束本次番茄钟">
            ⟲
          </button>
        </div>

        {/* 每轮结束生成一条记录：时长 · 暂停次数 · 用途 / 中断原因 */}
        {records.length > 0 && (
          <div className="pomo-log">
            {records.map((r) => (
              <div className="pomo-log-item" key={r.id}>
                <div className="pomo-log-head">
                  <span className={`pomo-log-kind ${r.kind}`}>{r.kind === 'done' ? '完成' : '中断'}</span>
                  <span className="pomo-log-meta">
                    {r.minutes} 分钟 · 暂停 {r.pauses} 次
                    {r.kind === 'aborted' ? ` · 实际 ${fmtElapsed(r.elapsedSec)}` : ''}
                  </span>
                  <span className="pomo-log-time">{fmtClock(r.at)}</span>
                </div>
                <p className="pomo-log-text" title={r.pauseReasons.join('\n')}>
                  {r.kind === 'done' ? '用于：' : '中断：'}
                  {r.text}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 设置（右上角 ⚙ 打开） */}
      {settingsOpen && !prompt && (
        <div className="pomo-overlay set">
          <div className="pomo-set-head">
            <span className="pomo-set-heading">番茄钟设置</span>
            <button className="pomo-set-x" onClick={onCloseSettings} aria-label="关闭设置">
              ✕
            </button>
          </div>

          <p className="pomo-set-caption">专注时长</p>

          <div className="pomo-set-stepper">
            <button className="pomo-step" onClick={() => applyMinutes(String(minutes - 5))} aria-label="减少 5 分钟">
              −
            </button>
            <div className="pomo-set-value">
              <input
                className="pomo-set-input"
                type="number"
                min={MIN_MINUTES}
                max={MAX_MINUTES}
                value={draftMin}
                onChange={(e) => {
                  setDraftMin(e.target.value)
                  applyMinutes(e.target.value)
                }}
                onBlur={() => setDraftMin(String(minutes))}
              />
              <span className="pomo-set-unit">分钟</span>
            </div>
            <button className="pomo-step" onClick={() => applyMinutes(String(minutes + 5))} aria-label="增加 5 分钟">
              ＋
            </button>
          </div>

          <input
            className="pomo-slider"
            type="range"
            min={MIN_MINUTES}
            max={120}
            step={5}
            value={Math.min(minutes, 120)}
            style={{ ['--fill' as string]: `${((Math.min(minutes, 120) - MIN_MINUTES) / (120 - MIN_MINUTES)) * 100}%` }}
            onChange={(e) => applyMinutes(e.target.value)}
            aria-label="拖动调整专注时长"
          />

          <div className="pomo-set-presets">
            {PRESETS.map((p) => (
              <button
                key={p}
                className={`pomo-chip ${p === minutes ? 'on' : ''}`}
                onClick={() => applyMinutes(String(p))}
              >
                {p} 分钟
              </button>
            ))}
          </div>

          <p className="pomo-set-hint">
            {active ? '本轮进行中，新时长从下一轮开始生效' : '点 ▶ 开始一轮；中途暂停或结束需要写明原因'}
          </p>

          <button className="pomo-btn primary block" onClick={onCloseSettings}>
            完成
          </button>
        </div>
      )}

      {/* 暂停 / 结束原因、完成内容：三处共用一个弹层，原因为空时不能确认 */}
      {promptText && (
        <div className="pomo-overlay center">
          <p className="pomo-overlay-title">{promptText.title}</p>
          <p className="pomo-overlay-hint">{promptText.hint}</p>
          <textarea
            className="pomo-input"
            value={draft}
            autoFocus
            placeholder={promptText.placeholder}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="pomo-actions">
            {prompt !== 'done' && (
              <button className="pomo-btn" onClick={() => setPrompt(null)}>
                {prompt === 'pause' ? '继续专注' : '取消'}
              </button>
            )}
            <button className="pomo-btn primary" disabled={!draft.trim()} onClick={onConfirm}>
              {promptText.ok}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
