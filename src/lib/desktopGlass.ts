/**
 * 桌面液态玻璃层（WebGL，真折射）
 *
 * 背景事实：Chromium 里没有任何 CSS 手段能弯折背景（SVG 滤镜式 backdrop-filter 实测不可用），
 * 真折射只能靠着色器逐像素算。这一层负责：
 *   1. 把壁纸铺成窗口背景（cover 对齐）；
 *   2. 对每个 .module-card 的圆角矩形跑玻璃着色器：倒角厚度折射 + RGB 分光 +
 *      沿法线的镜面高光 + 面板色调，外加面板外的柔和投影。
 *
 * 生效时给 <body> 加 class `glass-live`，CSS 会把卡片的背景/边框/模糊让位给这一层。
 */

import wallUrl from '../assets/kairos-wall.png'
import { invoke, listen } from './tauri'

interface WinGeometry {
  screen: { width: number; height: number }
  bounds: { x: number; y: number }
}

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos;
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}
`

/** 背景：把壁纸按 cover 铺满画布，再压一层很轻的冷色薄纱 */
const FRAG_BG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uRes;      // 画布尺寸
uniform vec2 uImg;      // 壁纸尺寸
uniform vec3 uBase;     // cover 映射：缩放 + 偏移 (scale, offsetX, offsetY)

void main() {
  // WebGL 的 y 轴向上，这里换算成自上而下的像素坐标（与 getBoundingClientRect 一致）
  vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uRes;
  vec3 col = texture2D(uTex, clamp((px * uBase.x + uBase.yz) / uImg, 0.0, 1.0)).rgb;
  col = mix(col, col * vec3(0.94, 0.98, 1.1), 0.3);
  gl_FragColor = vec4(col, 1.0);
}
`

/** 玻璃：圆角矩形 SDF + 倒角折射 + 色散 + 镜面 + 面板色调 + 外投影 */
const FRAG_GLASS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform vec2 uImg;
uniform vec3 uBase;
uniform vec4 uRect;     // 面板 (x, y, w, h)，画布像素
uniform float uRadius;
uniform vec2 uLight;    // 光源（鼠标）位置，画布像素
uniform vec3 uTint;     // 面板底色
uniform float uTintA;   // 面板底色强度

float sdRound(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

vec3 backdrop(vec2 px) {
  return texture2D(uTex, clamp((px * uBase.x + uBase.yz) / uImg, 0.0, 1.0)).rgb;
}

void main() {
  // 自上而下的像素坐标（与 getBoundingClientRect 一致；WebGL 的 y 轴向上）
  vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uRes;
  vec2 c = uRect.xy + uRect.zw * 0.5;
  vec2 b = uRect.zw * 0.5;
  float d = sdRound(px - c, b, uRadius);

  // 面板外：只输出投影（纯压暗，alpha 混合，不覆盖背景）——
  // 否则每块玻璃的整屏 quad 会把之前画好的面板全部盖掉
  if (d > 0.5) {
    float sh = 1.0 - smoothstep(3.0, 52.0, d);
    float side = 0.55 + 0.45 * smoothstep(-0.4, 1.0, (px.y - c.y) / max(b.y, 1.0));
    gl_FragColor = vec4(0.0, 0.0, 0.0, sh * 0.5 * side);
    return;
  }

  // 边缘法线（SDF 梯度）
  float e = 1.5;
  vec2 grad = normalize(vec2(
    sdRound(px + vec2(e, 0.0) - c, b, uRadius) - sdRound(px - vec2(e, 0.0) - c, b, uRadius),
    sdRound(px + vec2(0.0, e) - c, b, uRadius) - sdRound(px - vec2(0.0, e) - c, b, uRadius)
  ) + 1e-6);

  // t: 0 = 最外缘，1 = 完全进入玻璃
  float bevel = min(40.0, min(b.x, b.y) * 0.6);
  float t = clamp(-d / bevel, 0.0, 1.0);
  float rim = pow(1.0 - t, 2.4);

  // 折射：采样点沿法线向内推，越靠边越强（厚玻璃透镜）+ 内部轻微放大
  float bend = rim * 38.0;
  vec2 samplePx = px - grad * bend;
  float mag = 1.0 + 0.022 * smoothstep(0.0, 1.0, t);
  samplePx = c + (samplePx - c) * mag;

  // 色散：R/B 沿法线错开
  vec2 off = grad * (rim * 3.6);
  vec3 col;
  col.r = backdrop(samplePx + off).r;
  col.g = backdrop(samplePx).g;
  col.b = backdrop(samplePx - off).b;

  // 面板色调（vibrancy）：轻微压暗折射到的背景，再叠一点冷色——
  // 压暗量别太重，否则壁纸就被"吃掉"，看不到背景了
  col *= mix(0.96, 0.8, t);
  col = mix(col, uTint * 1.5, uTintA * (0.7 + 0.3 * t));

  // 厚度：边缘略暗 + 最外 1.5px 亮棱
  col *= 1.0 - rim * 0.14;
  col += vec3(1.0) * smoothstep(1.8, 0.0, abs(d)) * 0.42;

  // 镜面：沿法线朝光源的一侧 + 固定顶部主光
  vec2 L = normalize(uLight - px);
  float spec = pow(max(dot(grad, L), 0.0), 3.0) * pow(1.0 - t, 1.4);
  float top = pow(max(dot(grad, normalize(vec2(-0.5, -1.0))), 0.0), 2.6);
  col += vec3(1.0) * (spec * 0.8 + top * 0.45) * rim;

  float alpha = 1.0 - smoothstep(-1.0, 0.5, d);
  gl_FragColor = vec4(col, alpha);
}
`

interface Panel {
  x: number
  y: number
  w: number
  h: number
  r: number
}

/**
 * 面板色调从 CSS 变量读（body.glass-live 上定义），改样式即时生效、方便调参：
 *   --glass-tint: "r, g, b"（0-255）
 *   --glass-tint-alpha: 0..1
 */
function readTint(): { rgb: [number, number, number]; alpha: number } {
  const cs = getComputedStyle(document.body)
  const parts = cs.getPropertyValue('--glass-tint').split(',').map((v) => parseFloat(v) || 0)
  const alpha = parseFloat(cs.getPropertyValue('--glass-tint-alpha'))
  return {
    rgb: [(parts[0] || 0) / 255, (parts[1] || 0) / 255, (parts[2] || 0) / 255],
    alpha: Number.isFinite(alpha) ? alpha : 0.36,
  }
}

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type)
  if (!s) throw new Error('createShader failed')
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(String(gl.getShaderInfoLog(s)))
  return s
}

function link(gl: WebGLRenderingContext, fragSrc: string) {
  const p = gl.createProgram()
  if (!p) throw new Error('createProgram failed')
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT))
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragSrc))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(String(gl.getProgramInfoLog(p)))
  return p
}

export interface DesktopGlass {
  dispose: () => void
  measure: () => Panel[]
}

const dpr = () => Math.min(2, window.devicePixelRatio || 1)

/** 启动液态玻璃层（壁纸折射）。失败抛错，调用方据此保留 CSS 玻璃。 */
export async function startDesktopGlass(): Promise<DesktopGlass> {
  // 窗口在屏幕上的位置：背景壁纸按"窗口覆盖屏幕的那一块"采样，与桌面严丝合缝
  const geo = await invoke<WinGeometry>('win_geometry')
  const canvas = document.createElement('canvas')
  canvas.className = 'glass-canvas'
  document.body.insertBefore(canvas, document.body.firstChild)

  const gl = canvas.getContext('webgl', { antialias: false, alpha: false })
  if (!gl) {
    canvas.remove()
    throw new Error('webgl unavailable')
  }

  // 壁纸纹理
  const img = new Image()
  img.src = wallUrl
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('wallpaper load failed'))
  })

  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  // 不加 UNPACK_FLIP_Y：让纹理 v=0 对应图片顶部，配合着色器里自上而下的 px 采样
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  const progBg = link(gl, FRAG_BG)
  const progGlass = link(gl, FRAG_GLASS)

  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)

  // 壁纸 → 屏幕的映射（桌面壁纸按 cover 铺满屏幕），再叠窗口的屏幕偏移：
  //   image_px = (winX + page_px) * inv + centerOffset      （inv = 图片像素 / 屏幕像素）
  // 这样窗口里的背景和桌面上看到的是同一片壁纸
  const cover = () => {
    const scale = Math.max(geo.screen.width / img.naturalWidth, geo.screen.height / img.naturalHeight)
    const inv = 1 / scale
    const offX = (img.naturalWidth * scale - geo.screen.width) / 2 / scale
    const offY = (img.naturalHeight * scale - geo.screen.height) / 2 / scale
    return { inv, offX, offY }
  }
  let base = cover()

  // 光源（镜面高光跟着鼠标）
  let light: [number, number] = [window.innerWidth * 0.3, window.innerHeight * 0.15]
  const onMove = (e: PointerEvent) => {
    light = [e.clientX * dpr(), e.clientY * dpr()]
  }
  window.addEventListener('pointermove', onMove)

  const resize = () => {
    const d = dpr()
    canvas.width = Math.round(window.innerWidth * d)
    canvas.height = Math.round(window.innerHeight * d)
    canvas.style.width = window.innerWidth + 'px'
    canvas.style.height = window.innerHeight + 'px'
  }
  resize()
  window.addEventListener('resize', () => {
    resize()
    base = cover()
  })

  // 拖动/缩放窗口 → 换背景采样区域，保证与桌面一致
  const offBounds = await listen<WinGeometry['bounds']>('win-bounds', ({ payload }) => {
    if (payload) geo.bounds = payload
    base = cover()
  })

  const measure = (): Panel[] => {
    const d = dpr()
    const out: Panel[] = []
    document.querySelectorAll<HTMLElement>('.module-card').forEach((el) => {
      if (el.classList.contains('card-hidden')) return
      const b = el.getBoundingClientRect()
      if (b.width < 8 || b.height < 8) return
      const cs = getComputedStyle(el)
      const r = parseFloat(cs.borderTopLeftRadius) || 16
      out.push({ x: b.left * d, y: b.top * d, w: b.width * d, h: b.height * d, r: r * d })
    })
    return out
  }

  const attrib = (p: WebGLProgram) => {
    const loc = gl.getAttribLocation(p, 'aPos')
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  }

  let raf = 0
  let disposed = false
  const MIN_INTERVAL = 1000 / 60
  let lastDraw = 0
  let frameCount = 0
  let tint = readTint()

  const frame = (now: number) => {
    if (disposed) return
    raf = requestAnimationFrame(frame)
    if (now - lastDraw < MIN_INTERVAL) return
    lastDraw = now
    if (frameCount++ % 30 === 0) tint = readTint()

    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex)

    gl.disable(gl.BLEND)
    gl.useProgram(progBg)
    attrib(progBg)
    gl.uniform1i(gl.getUniformLocation(progBg, 'uTex'), 0)
    gl.uniform2f(gl.getUniformLocation(progBg, 'uRes'), canvas.width, canvas.height)
    gl.uniform2f(gl.getUniformLocation(progBg, 'uImg'), img.naturalWidth, img.naturalHeight)
    gl.uniform3f(
      gl.getUniformLocation(progBg, 'uBase'),
      base.inv,
      base.offX + geo.bounds.x * base.inv,
      base.offY + geo.bounds.y * base.inv,
    )
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(progGlass)
    attrib(progGlass)
    gl.uniform1i(gl.getUniformLocation(progGlass, 'uTex'), 0)
    gl.uniform2f(gl.getUniformLocation(progGlass, 'uRes'), canvas.width, canvas.height)
    gl.uniform2f(gl.getUniformLocation(progGlass, 'uImg'), img.naturalWidth, img.naturalHeight)
    gl.uniform3f(
      gl.getUniformLocation(progGlass, 'uBase'),
      base.inv,
      base.offX + geo.bounds.x * base.inv,
      base.offY + geo.bounds.y * base.inv,
    )
    gl.uniform2f(gl.getUniformLocation(progGlass, 'uLight'), light[0], light[1])
    gl.uniform3f(gl.getUniformLocation(progGlass, 'uTint'), tint.rgb[0], tint.rgb[1], tint.rgb[2])
    gl.uniform1f(gl.getUniformLocation(progGlass, 'uTintA'), tint.alpha)
    for (const p of measure()) {
      gl.uniform4f(gl.getUniformLocation(progGlass, 'uRect'), p.x, p.y, p.w, p.h)
      gl.uniform1f(gl.getUniformLocation(progGlass, 'uRadius'), p.r)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
  }

  document.body.classList.add('glass-live')
  raf = requestAnimationFrame(frame)
  console.log(`[glass] 折射层接管：${measure().length} 块玻璃，画布 ${canvas.width}x${canvas.height}`)

  return {
    measure,
    dispose: () => {
      disposed = true
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
      offBounds()
      document.body.classList.remove('glass-live')
      canvas.remove()
    },
  }
}
