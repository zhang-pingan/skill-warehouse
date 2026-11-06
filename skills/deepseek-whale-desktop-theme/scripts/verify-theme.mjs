#!/usr/bin/env node

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  if (index + 1 >= process.argv.length) throw new Error(`${name} requires a value`)
  return process.argv[index + 1]
}

const cdpUrl = argument('--cdp-url', process.env.DSH_CDP_URL ?? 'http://127.0.0.1:9222')
const tabsResponse = await fetch(`${cdpUrl.replace(/\/$/, '')}/json/list`)
if (!tabsResponse.ok) throw new Error(`CDP target list failed: HTTP ${tabsResponse.status}`)
const tabs = await tabsResponse.json()
const tab = tabs.find((item) => item.type === 'page' && item.url === 'dsh-app://app/')
  ?? tabs.find((item) => item.type === 'page' && typeof item.webSocketDebuggerUrl === 'string')
if (!tab?.webSocketDebuggerUrl) throw new Error('No Desktop page with a CDP WebSocket was found')

const socket = new WebSocket(tab.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const expression = String.raw`(async () => {
  const readJson = async (path) => {
    const response = await fetch(path)
    return { status: response.status, body: await response.json() }
  }
  const active = await readJson('/api/skin-center/v2/active')
  const rawBoot = await readJson('/dsh-boot-animation/status.json')
  const boot = {
    status: rawBoot.status,
    body: {
      selectedClipId: rawBoot.body.selectedClipId,
      randomPlayback: rawBoot.body.randomPlayback,
      fitMode: rawBoot.body.fitMode,
      playOnAppStart: rawBoot.body.playOnAppStart,
      conversationClipId: rawBoot.body.conversationClipId,
      conversationOverrideCount: rawBoot.body.conversationOverrideCount,
      diagnostics: { version: rawBoot.body.diagnostics?.version ?? null },
    },
  }
  const video = [...document.querySelectorAll('video')].find((item) =>
    item.currentSrc.includes('/api/skin-center/v2/skins/whale-fantasy/assets/whale-fantasy-loop.mp4')
  ) ?? null
  const wasPaused = video?.paused ?? null
  let playError = null
  if (video?.paused) {
    try { await video.play() } catch (error) { playError = String(error?.message ?? error) }
  }
  const currentTimeBefore = video?.currentTime ?? null
  if (video !== null) await new Promise((resolve) => setTimeout(resolve, 1200))
  const buttons = [...document.querySelectorAll('.dba-pin-wrap > button.dba-pin')]
  return {
    rootSkin: document.documentElement.dataset.dshSkin ?? null,
    active,
    video: video === null ? null : {
      src: video.currentSrc,
      wasPaused,
      paused: video.paused,
      muted: video.muted,
      loop: video.loop,
      readyState: video.readyState,
      playError,
      currentTimeBefore,
      currentTimeAfter: video.currentTime,
    },
    boot,
    icons: {
      stylePresent: document.getElementById('whale-intro-icons-style') !== null,
      buttons: buttons.map((button) => {
        const normal = getComputedStyle(button)
        const before = getComputedStyle(button, '::before')
        return {
          className: button.className,
          title: button.title,
          fontSize: normal.fontSize,
          color: normal.color,
          width: before.width,
          maskImage: before.maskImage || before.webkitMaskImage || '',
        }
      }),
    },
  }
})()`

const observed = await new Promise((resolve, reject) => {
  const id = 1
  const timer = setTimeout(() => reject(new Error('CDP evaluation timed out')), 15_000)
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== id) return
    clearTimeout(timer)
    if (message.error || message.result?.exceptionDetails) {
      reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)))
      return
    }
    resolve(message.result.result.value)
  })
  socket.send(JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: { expression, awaitPromise: true, returnByValue: true },
  }))
}).finally(() => socket.close())

const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }
const background = observed.active?.body?.background
const boot = observed.boot?.body

check(observed.rootSkin === 'whale-fantasy', 'root skin attribute is not whale-fantasy')
check(observed.active?.status === 200 && observed.active?.body?.active === 'whale-fantasy', 'active skin API does not report whale-fantasy')
check(background?.enabled === true, 'skin background is not enabled')
for (const key of ['backgroundOpacity', 'backgroundBlurEmpty', 'backgroundBlurContent', 'inputCardBlur', 'bubbleOpacity', 'bubbleBlur']) {
  check(background?.[key] === 0, `background.${key} is not 0`)
}
check(observed.video !== null, 'whale-fantasy background video is not mounted')
check(observed.video?.paused === false, `background video could not play${observed.video?.playError ? `: ${observed.video.playError}` : ''}`)
check(observed.video?.muted === true, 'background video is not muted')
check(observed.video?.loop === true, 'background video is not looping')
check((observed.video?.readyState ?? 0) >= 2, 'background video is not ready to play')
check((observed.video?.currentTimeAfter ?? 0) > (observed.video?.currentTimeBefore ?? 0) + 0.1, 'background video timeline did not advance')
check(observed.boot?.status === 200, 'boot status endpoint did not return HTTP 200')
check(boot?.diagnostics?.version === '0.4.2', 'boot plugin runtime version is not 0.4.2')
check(boot?.selectedClipId === 'builtin:awakening', 'startup clip is not builtin:awakening')
check(boot?.randomPlayback === false, 'startup random playback is not off')
check(boot?.fitMode === 'cover', 'startup fit mode is not cover')
check(boot?.playOnAppStart === true, 'startup app-start playback is not on')
check(boot?.conversationOverrideCount === 0, 'startup has conversation overrides; preserve or clear them deliberately')
check(observed.icons?.stylePresent === true, 'accessory icon stylesheet is absent')
check(observed.icons?.buttons?.length === 2, 'expected two original accessory controls')
for (const [index, button] of (observed.icons?.buttons ?? []).entries()) {
  check(button.fontSize === '0px', `accessory button ${index + 1} still renders its emoji text`)
  check(button.width === '18px', `accessory button ${index + 1} icon is not 18px`)
  check(button.maskImage && button.maskImage !== 'none', `accessory button ${index + 1} has no SVG mask`)
}

console.log(JSON.stringify(observed, null, 2))
if (failures.length > 0) {
  console.error('\nTheme verification failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('\nTheme verification passed.')
}
