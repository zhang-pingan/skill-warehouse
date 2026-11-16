import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const zh = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
const en = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))

test('memory graph uses only queried records and explicit relationship endpoints', () => {
  const start = client.indexOf('function memoryGraphData(')
  const end = client.indexOf('\n    function MemoryGraph(', start)
  const memoryGraphData = runInNewContext(`(${client.slice(start, end)})`)
  const graph = memoryGraphData([
    { type: 'entity', id: 'entity-1', name: 'Workspace' },
    { type: 'relation', id: 'edge-1', fromKind: 'entity', fromId: 'entity-1', from: 'Workspace', toKind: 'task', toId: 'task-1', to: 'Review', relation: 'owns' },
    { type: 'relation', id: 'edge-unlinked', fromKind: 'entity', fromId: 'entity-1', relation: 'unknown' },
    { type: 'unrecognized', id: 'ignored', name: 'Not a memory record' },
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(graph.edges.map(edge => [edge.from, edge.to, edge.label]))), [['entity:entity-1', 'task:task-1', 'owns']])
  assert.deepEqual(JSON.parse(JSON.stringify(graph.nodes.map(node => node.key).sort())), ['entity:entity-1', 'task:task-1'])
})

function assistantHost(ctx, canonical = { sessionId: 'existing-assistant', agentPreset: 'standard' }) {
  const start = client.indexOf('function createAssistantSessionHost(')
  const end = client.indexOf('\n    function formatDate(', start)
  const createHost = runInNewContext(`(${client.slice(start, end)})`, {
    fetch: async () => { if (canonical instanceof Error) throw canonical; return canonical },
    remoteValue: result => { if (!result.ok) throw new Error(result.error.message); return result.value },
    responseJson: async value => value,
  })
  return createHost(ctx, value => value)
}

test('opening the assistant restores its existing session before mounting and coalesces callers', async () => {
  const restoration = Promise.withResolvers()
  let archived = true
  let restores = 0
  let releases = 0
  let retains = 0
  const reference = { ready: Promise.resolve(), release() { releases += 1 } }
  const host = assistantHost({
    workspaces: { async unarchiveSession(id) {
      assert.equal(id, 'existing-assistant')
      restores += 1
      await restoration.promise
      archived = false
    } },
    sessions: { retain(id) {
      assert.equal(id, 'existing-assistant')
      assert.equal(archived, false)
      retains += 1
      return reference
    }, create() { assert.fail('must reuse the existing assistant') } },
  })
  try {
    const first = host.ensure()
    assert.equal(host.ensure(), first)
    restoration.resolve()
    assert.equal(await first, reference)
    assert.equal(restores, 1)
    archived = true
    assert.equal(await host.ensure(), reference)
    assert.equal(archived, false)
    assert.equal(restores, 2)
    assert.equal(retains, 1)
  } finally { restoration.resolve(); host.dispose() }
  assert.equal(releases, 1)
})

test('failed assistant restoration remains visible and does not mount a blocked conversation', async () => {
  const host = assistantHost({
    workspaces: { async unarchiveSession() { throw new Error('restore failed') } },
    sessions: { retain() { assert.fail('must stop before mounting') } },
  })
  try {
    assert.equal(await host.ensure(), null)
    assert.equal(host.getSnapshot().reference, null)
    assert.equal(host.getSnapshot().error, 'restore failed')
    assert.equal(host.getSnapshot().loading, false)
  } finally { host.dispose() }
})

test('opening a nonstandard assistant creates one standard successor without altering the old session', async () => {
  const actions = []
  const reference = { ready: Promise.resolve(), release() {} }
  const host = assistantHost({
    workspaces: { async initializeDefault() { return { workspaceId: 'workspace' } }, async unarchiveSession(id) { actions.push(['restore', id]) } },
    sessions: {
      async create(request) { actions.push(['create', JSON.parse(JSON.stringify(request))]); return 'standard-successor' },
      async using(id, _options, use) {
        assert.equal(id, 'standard-successor')
        await use({ binding: { session: { async command(command) { actions.push(['command', command]); return { ok: true, value: { matched: true } } } } } })
      },
      retain(id) { actions.push(['retain', id]); return reference },
    },
  }, { sessionId: 'old-creator', agentPreset: 'cordis' })
  try {
    assert.equal(await host.ensure(), reference)
    assert.deepEqual(actions, [
      ['create', { workspaceId: 'workspace', agentPreset: 'standard' }],
      ['command', '/personal-assistant'], ['restore', 'standard-successor'], ['retain', 'standard-successor'],
    ])
    assert.equal(await host.ensure(), reference)
    assert.equal(actions.filter(([kind]) => kind === 'create').length, 1)
  } finally { host.dispose() }
})

test('an unreadable assistant target does not create a replacement session', async () => {
  const host = assistantHost({
    sessions: { create() { assert.fail('a read failure must not replace the target') } },
  }, new Error('target unavailable'))
  try {
    assert.equal(await host.ensure(), null)
    assert.equal(host.getSnapshot().error, 'target unavailable')
  } finally { host.dispose() }
})

test('client hosts one durable native assistant conversation inside the assistant panel', () => {
  assert.match(client, /inject: \['slots', 'locale', 'layout', 'sessions', 'workspaces', 'uiWorkspace'\]/)
  assert.match(client, /fetch\('\/api\/personal-agent\/session'/)
  assert.match(client, /canonical\.agentPreset === 'standard' \? canonical\.sessionId : await createSession\(\)/)
  assert.match(client, /if \(pending\) return pending/)
  assert.match(client, /ctx\.sessions\.retain\(sessionId, \{ source: 'personalAssistantMain' \}\)/)
  assert.match(client, /const workspace = await ctx\.workspaces\.initializeDefault\(\)/)
  assert.match(client, /const sessionId = await ctx\.sessions\.create\(\{ workspaceId: workspace\.workspaceId, agentPreset: 'standard' \}\)/)
  assert.match(client, /reference\.binding\.session\.command\('\/personal-assistant'\)/)
  assert.doesNotMatch(client, /ctx\.uiWorkspace\.openSession\(reference\.binding\.session\.sessionId\)/)
  assert.match(client, /children: \{ 'personal-agent-core\.conversation': \{ kind: 'single', scope: 'session' \} \}/)
  assert.doesNotMatch(client, /FixedAssistantConversationView|AssistantConversationPanel|pac-main-toolbar/)
  assert.doesNotMatch(client, /selectPanel\?\.\(null\)|selectPanel\(null\)/)
  assert.doesNotMatch(client.slice(client.indexOf('function AssistantMain('), client.indexOf('function installAssistantContextVisibility(')), /store\.closeSidebar\(\)/)
  assert.doesNotMatch(client.slice(client.indexOf('function AssistantMain')), /h\('textarea'/)
  assert.doesNotMatch(client, /session\.prompt\(/)
  assert.doesNotMatch(client, /pac-composer|pac-textarea|pac-send/)
  const assistantStart = client.indexOf('function AssistantMain(')
  const assistantEnd = client.indexOf('\n    function installAssistantContextVisibility', assistantStart)
  assert.doesNotMatch(client.slice(assistantStart, assistantEnd), /h\('select'/)
  assert.match(client, /ctx\.slots\.inject\('conversation\.input\.dock'/)
  assert.match(client, /data-pac-assistant-session/)
  assert.match(client, /data-context-source/)
  assert.match(client, /data-context-injection-body/)
  assert.match(client, /data-pac-hidden-context/)
  assert.match(client, /installAssistantContextVisibility\(\)/)
  assert.match(client, /button\[class\*="_workspace"\]\[aria-haspopup="menu"\]\{display:none\}/)
  assert.doesNotMatch(client, /ctx\.slots\.inject\('conversation\.composer'/)
  assert.doesNotMatch(client, /\/api\/personal-agent\/operate/)
})

test('assistant page binds its retained session without changing ordinary navigation', async () => {
  const reference = { sessionId: 'private-main' }
  const state = { reference: null, loading: true, error: '' }
  const effects = []
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children })
  const start = client.indexOf('function AssistantMain(')
  const end = client.indexOf('\n    function AssistantConversation(', start)
  const AssistantMain = runInNewContext(`(${client.slice(start, end)})`, {
    h, Button: 'button', React: { useSyncExternalStore: (_subscribe, snapshot) => snapshot(), useEffect: effect => effects.push(effect) },
  })
  let opens = 0
  const host = { subscribe() {}, getSnapshot: () => state, async ensure() { opens += 1; state.reference = reference; state.loading = false } }
  const SessionProvider = () => {}
  const props = { host, t: key => key, SessionProvider,
    ctx: { uiWorkspace: { openSession() { assert.fail('the assistant must stay in its own panel') } } },
    renderSlot: (name, owner) => ({ name, owner }),
  }
  assert.equal(AssistantMain(props).props.className, 'pac-launch')
  await effects.shift()()
  const view = AssistantMain(props)
  assert.equal(opens, 1)
  assert.equal(view.type, SessionProvider)
  assert.equal(view.props.session, reference)
  assert.equal(view.children[0].name, 'personal-agent-core.conversation')
  state.error = 'restore unavailable'
  const failed = AssistantMain(props)
  assert.equal(failed.children[0].props.role, 'alert')
  assert.match(failed.children[0].children[0], /restore unavailable/)
  assert.equal(failed.children[1].props.onClick, host.ensure)
})

test('assistant page keeps its title and actions around the shared native conversation', () => {
  const start = client.indexOf('function AssistantConversation(')
  const end = client.indexOf('\n    function installAssistantContextVisibility(', start)
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children })
  const TaskHeaderAction = () => {}
  const Conversation = runInNewContext(`(${client.slice(start, end)})`, { h, TaskHeaderAction })
  const nativeCalls = []
  const view = Conversation({ sessionId: 'private-main', store: {}, t: key => key,
    renderFactorySlot: (name, input) => { nativeCalls.push([name, JSON.parse(JSON.stringify(input))]); return 'native-conversation' },
  })
  assert.equal(view.props.className, 'pac-assistant-page')
  assert.equal(view.children[0].children[0].children[0], 'panel')
  assert.equal(view.children[0].children[1].props.sessionId, 'private-main')
  assert.deepEqual(nativeCalls, [['conversation.content', { variant: 'embedded', phase: 'active', hero: false }]])
})

test('client mounts a task-only dashboard in the non-conflicting shell overlay', () => {
  assert.match(client, /@deepseek-ai\/dsh-client-ui-primitives/)
  assert.match(client, /const Glyph =/)
  assert.match(client, /panel: IconPanelLeftOutlineRegular/)
  assert.match(client, /checklist: IconChecklistOutlineRegular/)
  assert.doesNotMatch(client, /IconSendOutlineRegular/)
  assert.doesNotMatch(client, /h\('svg'/)
  assert.doesNotMatch(client, /function Icon\(/)
  assert.match(client, /ctx\.slots\.inject\('shell\.overlay'/)
  assert.match(client, /name: 'shell\.overlay', id: `\$\{PANEL\}\.tasks`/)
  assert.doesNotMatch(client, /name: 'shell\.overlay', key:/)
  assert.match(client, /ctx\.layout\?\.openRightbar\?\.\(true, false\)/)
  assert.match(client, /ctx\.layout\?\.closeRightbar\?\.\(\)/)
  assert.match(client, /\/api\/personal-agent\/dashboard/)
  assert.match(client, /\/api\/personal-agent\/task\?id=\$\{encodeURIComponent\(id\)\}/)
  assert.match(client, /tasks\?\.active/)
  assert.match(client, /tasks\?\.completed/)
  assert.match(client, /pac-codex-dot/)
  assert.doesNotMatch(client, /payload\.executions/)
  assert.doesNotMatch(client, /payload\.children/)
  assert.doesNotMatch(client, /detail\?\.routes/)
  assert.doesNotMatch(client, /t\('execution'\)/)
  assert.doesNotMatch(client, /schemaVersion/)
  assert.doesNotMatch(client, /outboxUncertain/)
  assert.doesNotMatch(client, /recoveryHolds/)
  assert.doesNotMatch(client, /evidence records/i)
})

test('client registers navigation and an assistant-only native header action', () => {
  assert.match(client, /name: 'main', key: PANEL, locale: NS/)
  assert.match(client, /name: 'sidebar\.panellist', id: PANEL, order: 25/)
  assert.match(client, /ctx\.slots\.inject\('conversation\.session\.header\.actions'/)
  assert.match(client, /name: 'conversation\.session\.header\.actions', id: `\$\{PANEL\}\.tasks`, order: 70/)
  assert.match(client, /\/api\/personal-agent\/session\?id=\$\{encodeURIComponent\(sessionId\)\}/)
  assert.match(client, /if \(!assistant\) return null/)
  assert.match(client, /label: \(\) => t\('panel'\)/)
  assert.match(client, /h\(Glyph, \{ name: 'panel'/)
  assert.match(client, /ctx\.slots\.inject\('settings\.section'/)
  assert.match(client, /id: PANEL, order: 40, label: \(\) => t\('settingsNav'\)/)
  assert.doesNotMatch(client.slice(client.indexOf('function SettingsSection('), client.indexOf('\n    function memoryGraphData(')), /MemoryBrowser/)
  assert.match(client, /name: 'shell\.overlay', id: `\$\{PANEL\}\.memory`/)
  assert.match(client, /'aria-modal': 'true'/)
  assert.match(client, /event\.key === 'Escape'/)
  assert.match(client, /video\.pause\(\)/)
  assert.match(client, /starmap_bg\.mp4/)
  assert.match(client, /ctx\.layout\?\.openRightbar\?\.\(true, true\)/)
  assert.match(client, /fetch\('\/api\/personal-agent\/settings'/)
  assert.match(client, /fetch\('\/api\/personal-agent\/settings\/codex'/)
  assert.match(client, /codexBusy === 'enabling' \? 'codexEnabling' : 'codexDisabling'/)
  assert.match(client, /disabled: busy, label: t\('codexWorkerEnabled'/)
  for (const locale of [zh, en]) {
    assert.equal(typeof locale.codexGroup, 'string')
    assert.equal(typeof locale.codexEnabling, 'string')
    assert.equal(typeof locale.codexDisabling, 'string')
  }
})

const settingUnitsStart = client.indexOf('const settingUnits = Object.freeze(')
const settingUnitsEnd = client.indexOf('\n\n    /** Keep structured drafts', settingUnitsStart)
const clientSettingUnits = runInNewContext(`${client.slice(settingUnitsStart, settingUnitsEnd)}; settingUnits`)

function settingsDraft() {
  return {
    codexWorkerEnabled: false, historyStartupSyncEnabled: true, historyPeriodicSyncEnabled: true, importIntervalMs: 900000,
    historyRetentionDays: 30, historyBatchSize: 32, historyBatchMs: 8, historyReadBytes: 8388608, maxImportFileBytes: 67108864,
    maxHistoryRecordBytes: 67108864, inboxRetryEnabled: true, inboxRetryIntervalMs: 30000, inboxBatchSize: 100, inboxRetryLimit: 5,
    inboxRetryBudgetMs: 100, backupEnabled: true, backupIntervalMs: 86400000, backupRetention: 14, memoryExtractionEnabled: true,
    memoryExtractionIntervalMs: 300000, memoryExtractionBatchSize: 12, memoryExtractionRetryLimit: 3, memoryExtractionBudgetMs: 600000,
    cleanupEnabled: true, cleanupIntervalMs: 86400000, semanticRoutingEnabled: true, analysisBudgetMs: 120000, analysisInputChars: 48000,
    analysisOutputChars: 12000, backgroundModelPolicy: '', dshWorkerEnabled: true, workerHeartbeatEnabled: true, dshWorkerPresets: ['standard'],
    defaultDshPreset: 'standard', workerBudgetMs: 1800000, routeResumeThreshold: 0.86, routeAmbiguityGap: 0.08,
    leaseTtlMs: 120000, workerHeartbeatMs: 30000, workerRules: [{ id: 'general', worker: 'dsh_subagent', keywords: [], capabilities: [], agentPreset: 'standard', _key: 'rule-0' }],
    modelPolicies: [],
  }
}

function settingsTestScope(React, overrides = {}) {
  const h = React.createElement
  return {
    React, h, settingUnits: clientSettingUnits, settingsToDraft: value => value, settingsFromDraft: value => value,
    settingsErrors: () => ({}), SettingsSelect: props => h('button', props),
    SettingsIconAction: ({ label, disabled, onClick }) => h('button', { type: 'button', 'aria-label': label, disabled, onClick }, label),
    Button: 'button', Switch: 'switch', Checkbox: 'checkbox', Menu: 'menu', Tooltip: 'tooltip',
    IconRefreshOutlineRegular: 'refresh', IconPlusOutlineRegular: 'plus', IconTrashOutlineRegular: 'trash',
    IconChevronDownOutlineRegular: 'down', IconSaveOutlineRegular: 'save',
    presetLabel: id => id, presetDescription: id => id, formatDate: () => '', requestSettings: async () => ({}), requestCodexToggle: async () => ({}),
    ...overrides,
  }
}

test('settings section renders native toggles and structured editors without JSON fields', () => {
  const start = client.indexOf('function SettingsSection(')
  const end = client.indexOf('\n    function memoryGraphData(', start)
  const states = [
    { jobs: [], progress: {}, presets: ['standard', 'cordis', 'ptc', 'minimal'].map(id => ({ id })), source: 'saved-settings' },
    settingsDraft(), settingsDraft(), settingsDraft(), false, false, false, null, '', '', '', false, {},
  ]
  let stateIndex = 0
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: () => [states[stateIndex++], () => {}],
    useRef: current => ({ current }),
    useId: () => 'settings-test',
    useEffect() {},
  }
  const SettingsSection = runInNewContext(`(${client.slice(start, end)})`, {
    ...settingsTestScope(React),
  })
  const tree = SettingsSection({ t: value => value })
  const nodes = []
  const visit = value => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (!value || typeof value !== 'object') return
    nodes.push(value)
    Object.values(value).forEach(visit)
  }
  visit(tree)
  const codexToggle = nodes.find(node => node.props?.label === 'codexWorkerEnabled')
  assert.ok(codexToggle)
  assert.equal(codexToggle.props.checked, false)
  assert.equal(nodes.some(node => node.type === 'textarea'), false)
  assert.ok(nodes.some(node => node.type === 'details'))
  assert.equal(nodes.filter(node => node.type === 'checkbox').length, 4)
  assert.deepEqual(nodes.filter(node => node.props?.className === 'pac-settings-preset-description').map(node => node.children[0]), ['standard', 'cordis', 'ptc', 'minimal'])
  assert.match(client.slice(start, end), /pac-job-table/)
  assert.match(client.slice(start, end), /pac-settings-preset-list/)
})

test('settings can remove the last unavailable DSH preset while protecting the last available preset', () => {
  const start = client.indexOf('function SettingsSection(')
  const end = client.indexOf('\n    function memoryGraphData(', start)
  const states = [
    { jobs: [], progress: {}, presets: [{ id: 'standard', broken: 'Preset no longer loads' }, { id: 'cordis' }], source: 'saved-settings' },
    { ...settingsDraft(), dshWorkerPresets: ['standard', 'cordis'] },
    { ...settingsDraft(), dshWorkerPresets: ['standard'] },
    { ...settingsDraft(), dshWorkerPresets: ['standard'] },
    false, false, false, null, '', '', '', false, {},
  ]
  let stateIndex = 0
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: () => [states[stateIndex++], () => {}],
    useRef: current => ({ current }),
    useId: () => 'settings-unavailable-test',
    useEffect() {},
  }
  const SettingsSection = runInNewContext(`(${client.slice(start, end)})`, settingsTestScope(React))
  const tree = SettingsSection({ t: value => value })
  const nodes = []
  const visit = value => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (!value || typeof value !== 'object') return
    nodes.push(value)
    Object.values(value).forEach(visit)
  }
  visit(tree)
  const standard = nodes.find(node => node.type === 'checkbox' && node.props.label === 'standard')
  const cordis = nodes.find(node => node.type === 'checkbox' && node.props.label === 'cordis')
  assert.equal(standard.props.disabled, false)
  assert.equal(cordis.props.disabled, true)
})

test('settings draft serializes structured rules and model policies with normalized references', () => {
  const start = client.indexOf('const settingUnits = Object.freeze(')
  const end = client.indexOf('\n    async function requestSettings(', start)
  const helpers = runInNewContext(`(() => { ${client.slice(start, end)}; return { settingsToDraft, settingsFromDraft } })()`)
  const draft = helpers.settingsToDraft(settingsDraft())
  draft.importIntervalMs = 90
  draft.backgroundModelPolicy = ' analysis '
  draft.modelPolicies = [{ _key: 'policy-0', name: ' analysis ', worker: 'dsh_subagent', provider: ' openai ', model: ' model-x ', effort: 'high' }]
  draft.workerRules = [
    { _key: 'rule-0', id: ' general ', worker: 'dsh_subagent', keywords: ['code'], capabilities: [], agentPreset: 'standard', modelPolicy: ' analysis ' },
    { _key: 'rule-1', id: ' codex ', worker: 'codex', keywords: [], capabilities: [], agentPreset: undefined },
  ]
  const normalized = JSON.parse(JSON.stringify(helpers.settingsFromDraft(draft)))
  assert.equal(normalized.importIntervalMs, 5400000)
  assert.equal(normalized.backgroundModelPolicy, 'analysis')
  assert.equal(normalized.modelPolicies.analysis.provider, 'openai')
  assert.equal(normalized.modelPolicies.analysis.model, 'model-x')
  assert.equal(normalized.workerRules[0].id, 'general')
  assert.equal(normalized.workerRules[0].modelPolicy, 'analysis')
  assert.equal(Object.hasOwn(normalized.workerRules[1], 'agentPreset'), false)
  assert.equal(Object.hasOwn(normalized, 'codexWorkerEnabled'), false)
  assert.equal(helpers.settingsToDraft({ ...normalized, importIntervalMs: 5400000 }).importIntervalMs, 90)
})

test('Codex setting serializes enable and disable operations and reports progress', async () => {
  const slots = new Map()
  const draft = settingsDraft()
  const initialStates = [
    { jobs: [], progress: {}, presets: [{ id: 'standard' }], source: 'saved-settings' }, draft, draft, draft,
    false, false, false, null, '', '', '', false, {},
  ]
  let hookIndex = 0
  let requests = []
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const index = hookIndex++
      if (!slots.has(index)) slots.set(index, { value: initialStates[index] ?? initial })
      const slot = slots.get(index)
      return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
    },
    useRef(current) {
      const index = hookIndex++
      if (!slots.has(index)) slots.set(index, { current })
      return slots.get(index)
    },
    useId() { hookIndex++; return 'settings-test' },
    useEffect() { hookIndex++ },
  }
  const settingsStart = client.indexOf('function SettingsSection(')
  const settingsEnd = client.indexOf('\n    function memoryGraphData(', settingsStart)
  const SettingsSection = runInNewContext(`(${client.slice(settingsStart, settingsEnd)})`, settingsTestScope(React, {
    requestCodexToggle: enabled => {
      const operation = Promise.withResolvers()
      requests.push({ enabled, ...operation })
      return operation.promise
    },
  }))
  const render = () => {
    hookIndex = 0
    return SettingsSection({ t: value => value })
  }
  const findNodes = tree => {
    const nodes = []
    const visit = value => {
      if (Array.isArray(value)) { value.forEach(visit); return }
      if (!value || typeof value !== 'object') return
      nodes.push(value)
      Object.values(value).forEach(visit)
    }
    visit(tree)
    return nodes
  }
  const assertOperationPending = (tree, stateLabel) => {
    const nodes = findNodes(tree)
    assert.ok(nodes.some(node => node.props?.role === 'status' && node.children?.includes(stateLabel)))
    for (const input of nodes.filter(node => node.type === 'input' || node.type === 'textarea')) {
      assert.equal(input.props.disabled, true)
    }
    assert.equal(nodes.find(node => node.props?.type === 'submit')?.props.disabled, true)
    assert.equal(nodes.find(node => node.props?.type === 'button' && node.children?.includes('settingsRestore'))?.props.disabled, true)
    return nodes.find(node => node.props?.label === 'codexWorkerEnabled')
  }

  let tree = render()
  let toggle = findNodes(tree).find(node => node.props?.label === 'codexWorkerEnabled')
  toggle.props.onChange(true)
  tree = render()
  toggle = assertOperationPending(tree, 'codexEnabling')
  assert.equal(toggle.props.checked, false)
  toggle.props.onChange(true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].enabled, true)
  requests[0].resolve({ settings: { codexWorkerEnabled: true }, jobs: [], progress: {}, presets: [{ id: 'standard' }] })
  await requests[0].promise
  await new Promise(resolve => setImmediate(resolve))

  tree = render()
  toggle = findNodes(tree).find(node => node.props?.label === 'codexWorkerEnabled')
  assert.equal(toggle.props.checked, true)
  assert.equal(toggle.props.disabled, false)
  assert.ok(findNodes(tree).some(node => node.props?.role === 'status' && node.children?.includes('codexEnabledResult')))

  toggle.props.onChange(false)
  tree = render()
  toggle = assertOperationPending(tree, 'codexDisabling')
  assert.equal(toggle.props.checked, true)
  toggle.props.onChange(false)
  assert.equal(requests.length, 2)
  assert.equal(requests[1].enabled, false)
  requests[1].resolve({ settings: { codexWorkerEnabled: false }, jobs: [], progress: {}, presets: [{ id: 'standard' }] })
  await requests[1].promise
  await new Promise(resolve => setImmediate(resolve))

  tree = render()
  toggle = findNodes(tree).find(node => node.props?.label === 'codexWorkerEnabled')
  assert.equal(toggle.props.checked, false)
  assert.equal(toggle.props.disabled, false)
  assert.ok(findNodes(tree).some(node => node.props?.role === 'status' && node.children?.includes('codexDisabledResult')))
})

test('client manifest and locales expose the simplified assistant surface', () => {
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-layout'))
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-workspace'))
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-api-session-controller'))
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-api-workspace-controller'))
  for (const locale of [zh, en]) {
    assert.equal(typeof locale.openDashboard, 'string')
    assert.equal(typeof locale.activeTasks, 'string')
    assert.equal(typeof locale.completedTasks, 'string')
    assert.equal(typeof locale.workers, 'string')
    assert.equal(typeof locale.settingsTitle, 'string')
    assert.equal(typeof locale.backupEnabled, 'string')
    assert.equal(Object.hasOwn(locale, 'inputLabel'), false)
    assert.equal(Object.hasOwn(locale, 'inputPlaceholder'), false)
    assert.equal(Object.hasOwn(locale, 'send'), false)
    assert.equal(Object.hasOwn(locale, 'taskCreateError'), false)
    assert.equal(Object.hasOwn(locale, 'schema'), false)
    assert.equal(Object.hasOwn(locale, 'projects'), false)
    assert.equal(Object.hasOwn(locale, 'evidence'), false)
    assert.equal(Object.hasOwn(locale, 'execution'), false)
    assert.equal(Object.hasOwn(locale, 'effort'), false)
    assert.equal(Object.hasOwn(locale, 'workspace'), false)
  }
})
