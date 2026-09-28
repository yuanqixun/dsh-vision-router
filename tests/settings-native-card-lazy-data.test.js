import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import { SETTINGS_NATIVE_CARD_IA_PRELUDE } from '../lib/settings-native-card-layout.js'

function reactWithEffects(cardsOpen, useDefaultCards = false) {
  let stateIndex = 0
  const effects = []
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useMemo(factory) { return factory() },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
    useState(initial) {
      const useOverride = stateIndex++ === 0 && !useDefaultCards
      const candidate = useOverride ? cardsOpen : initial
      const value = typeof candidate === 'function' ? candidate() : candidate
      return [value, () => {}]
    },
    useEffect(effect) { effects.push(effect) },
    useRef(initial) { return { current: initial } },
  }
  return { React, effects }
}

function settingsValue(overrides = {}) {
  return {
    providers: [{ provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B', fallbacks: [] }],
    freeFallback: true,
    tool: true,
    structuredVisionBootstrap: false,
    guidanceOverrides: [],
    wrappedProviders: [],
    localOllama: {},
    localLmStudio: {},
    ...overrides,
  }
}

function renderWith(cardsOpen, { cachedCatalog, settings = settingsValue(), useDefaultCards = false } = {}) {
  const { React, effects } = reactWithEffects(cardsOpen, useDefaultCards)
  let captured
  let component
  let modelCalls = 0
  let capabilityCalls = 0
  const scheduled = []
  const storage = new Map()
  if (cachedCatalog !== undefined) {
    storage.set('dsh-vision-router:last-model-catalog', JSON.stringify(cachedCatalog))
  }
  const loader = { load(spec) { captured = spec; return spec } }
  const sandbox = {
    window: {
      __ModuleLoader__: loader,
      location: { hostname: '127.0.0.1' },
      requestAnimationFrame(callback) { scheduled.push(callback); return scheduled.length },
    },
    document: { documentElement: { lang: 'zh-CN' } },
    navigator: {},
    localStorage: {
      getItem(key) { return storage.get(key) ?? null },
      setItem(key, value) { storage.set(key, String(value)) },
    },
    fetch(url) {
      if (url === '/_dsh/vision-router/model-capabilities') capabilityCalls += 1
      return Promise.resolve({ ok: true, json: async () => ({ capabilities: {}, builtinFallback: [] }) })
    },
    Object,
    Promise,
    Array,
    String,
    Number,
    Map,
    Set,
    WeakMap,
    Reflect,
    Proxy,
    Symbol,
    Math,
    JSON,
    Error,
    TypeError,
    console,
    setTimeout(callback) { scheduled.push(callback); return scheduled.length },
    clearTimeout() {},
  }
  vm.runInNewContext(SETTINGS_NATIVE_CARD_IA_PRELUDE, sandbox)
  loader.load({
    id: 'dsh-vision-router',
    factory() {
      return {
        apply(ctx) {
          ctx.slots.register(
            { name: 'settings.section', id: 'vision-router', order: 12 },
            function OriginalSection() {},
          )
        },
      }
    },
  })
  const plugin = captured.factory((id) => {
    assert.equal(id, 'react')
    return React
  })
  plugin.apply({
    slots: {
      register(_options, registered) {
        component = registered
        return () => {}
      },
    },
    locale: { define() {} },
  })
  const scope = {
    subscribe() { return () => {} },
    getSnapshot() { return { status: 'ready', writable: true, value: settings, user: {} } },
    async set() {},
    async load() {},
  }
  const tree = component({
    scope,
    getConnection() {
      return {
        api: {
          llm: {
            models() {
              modelCalls += 1
              return Promise.resolve({ groups: [], failures: [] })
            },
          },
        },
      }
    },
  })
  for (const effect of effects) effect()
  return {
    tree,
    flushBackground() {
      while (scheduled.length) scheduled.shift()()
    },
    calls() { return { modelCalls, capabilityCalls } },
  }
}

function textOf(node) {
  if (node === undefined || node === null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node !== 'object') return ''
  return textOf(node.children)
}

test('closed Settings cards perform no model-catalog or capability preload', () => {
  assert.deepEqual(renderWith({}).calls(), { modelCalls: 0, capabilityCalls: 0 })
})

test('Strategy and Local remain data-cold when expanded', () => {
  assert.deepEqual(renderWith({ strategy: true }).calls(), { modelCalls: 0, capabilityCalls: 0 })
  assert.deepEqual(renderWith({ local: true }).calls(), { modelCalls: 0, capabilityCalls: 0 })
})

test('General, Advanced, and Diagnostics defer model data until after first paint', () => {
  for (const cardsOpen of [{ general: true }, { advanced: true }, { diagnostics: true }]) {
    const rendered = renderWith(cardsOpen)
    assert.deepEqual(rendered.calls(), { modelCalls: 0, capabilityCalls: 0 })
    rendered.flushBackground()
    assert.deepEqual(rendered.calls(), { modelCalls: 1, capabilityCalls: 1 })
  }
})

test('General is expanded by default and schedules its background refresh', () => {
  const rendered = renderWith(undefined, { useDefaultCards: true })
  assert.match(textOf(rendered.tree), /识图模型/)
  assert.deepEqual(rendered.calls(), { modelCalls: 0, capabilityCalls: 0 })
  rendered.flushBackground()
  assert.deepEqual(rendered.calls(), { modelCalls: 1, capabilityCalls: 1 })
})

test('cached model catalog renders provider and model options before background refresh', () => {
  const rendered = renderWith(undefined, {
    useDefaultCards: true,
    cachedCatalog: {
      groups: [{ id: 'hxfl', name: 'HXFL', models: [{ id: 'deepseek-v4-flash' }] }],
      failures: [],
      storedAt: 1,
    },
    settings: settingsValue({
      providers: [{ provider: 'hxfl', model: 'deepseek-v4-flash', fallbacks: [] }],
    }),
  })

  const text = textOf(rendered.tree)
  assert.match(text, /HXFL \(hxfl\)/)
  assert.match(text, /deepseek-v4-flash/)
  assert.deepEqual(rendered.calls(), { modelCalls: 0, capabilityCalls: 0 })
})
