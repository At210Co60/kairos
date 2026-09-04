import { useState } from 'react'

/**
 * 翻译模块（雏形）
 * 语言选择 + 双语对照卡片；接入翻译 API 后 swap/翻译按钮生效。
 */

export default function TranslatePanel() {
  const [from, setFrom] = useState('英语')
  const [to, setTo] = useState('简体中文')
  const [source, setSource] = useState(
    'The future belongs to those who believe in the beauty of their dreams.'
  )
  const [result] = useState('未来属于那些相信梦想之美的人。')

  return (
    <div className="panel-stack translate">
      <div className="tr-lang-row">
        <select className="tr-select" value={from} onChange={(e) => setFrom(e.target.value)}>
          <option>自动检测</option>
          <option>英语</option>
          <option>中文</option>
          <option>日语</option>
        </select>
        <button
          className="tr-swap"
          title="交换语言"
          onClick={() => {
            setFrom(to)
            setTo(from)
          }}
        >
          ⇄
        </button>
        <select className="tr-select" value={to} onChange={(e) => setTo(e.target.value)}>
          <option>简体中文</option>
          <option>英语</option>
          <option>日语</option>
        </select>
      </div>
      <div className="glass-card tr-box">
        <textarea
          className="tr-source"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          rows={3}
        />
      </div>
      <div className="glass-card tr-box tr-result">
        <p>{result}</p>
      </div>
      <div className="tr-actions">
        <button className="tr-btn">🔊 朗读</button>
        <button className="tr-btn">📋 复制译文</button>
        <button className="tr-btn tr-btn-primary">立即翻译</button>
      </div>
      <p className="panel-note">翻译 API 接入后生效 · 当前为界面演示</p>
    </div>
  )
}
