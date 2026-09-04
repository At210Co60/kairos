import { useEffect, useRef, useState } from 'react'

/**
 * 剪贴板历史模块（雏形）
 * 结构就绪，剪贴板监听（Rust clipboard 插件）后续接入；
 * 数据接入后只需替换 DEMO_ITEMS 为真实历史即可，UI 不用动。
 */

interface ClipItem {
  kind: 'text' | 'link'
  text: string
  time: string
}

const DEMO_ITEMS: ClipItem[] = [
  { kind: 'text', text: '液态玻璃是一种模拟光学特性的设计语言……', time: '10:24' },
  { kind: 'link', text: 'https://github.com/XxHuberrr/Mineradio', time: '09:40' },
  { kind: 'text', text: '会议纪要 – 产品路线图\n· 重设计仪表盘\n· 性能优化方案', time: '09:15' },
  { kind: 'text', text: '¥1,349.00 · 收据 #73918', time: '昨天' },
]

export default function ClipboardPanel() {
  const [items] = useState<ClipItem[]>(DEMO_ITEMS)
  const [copied, setCopied] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  function copy(text: string) {
    navigator.clipboard.writeText(text).catch(() => {})
    setCopied(text)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(null), 1200)
  }

  return (
    <div className="panel-stack">
      {copied && <p className="panel-toast">已复制 ✓</p>}
      {items.map((item, i) => (
        <button
          key={i}
          className="glass-card clip-item"
          onClick={() => copy(item.text)}
          title="点击重新复制"
        >
          <span className={`clip-tag ${item.kind === 'link' ? 'clip-tag-link' : ''}`}>
            {item.kind === 'link' ? '链接' : '文本'}
          </span>
          <span className="clip-text">{item.text}</span>
          <span className="clip-time">{item.time}</span>
        </button>
      ))}
      <p className="panel-note">剪贴板自动监听即将上线 · 点击条目可重新复制</p>
    </div>
  )
}
