/**
 * 浏览器半体的装载冒烟测试：在 Node 里搭一个最小的
 * `window.__ModuleLoader__` + `document` + `react` + client ctx 桩，验证
 *   1. bundle 以约定的 id 注册工厂，且 factory 返回可用的 apply / inject；
 *   2. apply() 按右侧栏契约注册：sidebarRightTabs.register（tab 类型 + guide 行）
 *      + sidebar.right.pane.tab 的 tab 体；
 *   3. 卸载（disposer）会把 tab 类型与 tab 体都撤掉。
 *
 * 组件本身不在 Node 里渲染（没有 React DOM），这里只验证「接线」是对的。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'lib', 'client.js')

function loadBundle() {
	const registrations = []
	const tabTypes = []
	let loaded = null

	const slots = {
		inject(key, callback) {
			const dispose = callback()
			return () => {
				if (typeof dispose === 'function') dispose()
			}
		},
		register(options) {
			registrations.push(options)
			return () => {
				const index = registrations.indexOf(options)
				if (index >= 0) registrations.splice(index, 1)
			}
		},
	}

	const sidebarRightTabs = {
		register(definition) {
			tabTypes.push(definition)
			return () => {
				const index = tabTypes.indexOf(definition)
				if (index >= 0) tabTypes.splice(index, 1)
			}
		},
	}

	const reactStub = {
		Component: class Component {
			constructor(props) {
				this.props = props
			}
		},
		useState: () => [undefined, () => {}],
		useEffect: () => {},
		useCallback: (fn) => fn,
		useRef: () => ({ current: null }),
		createElement: () => null,
	}

	const windowStub = {
		__ModuleLoader__: {
			load(registration) {
				loaded = registration
			},
		},
		addEventListener() {},
		removeEventListener() {},
	}

	const documentStub = {
		createElement: () => ({ setAttribute() {}, appendChild() {}, parentNode: null, textContent: '' }),
		head: { appendChild() {}, removeChild() {} },
	}

	const previousWindow = globalThis.window
	const previousDocument = globalThis.document
	globalThis.window = windowStub
	globalThis.document = documentStub
	try {
		const source = readFileSync(bundlePath, 'utf8')
		// 直接在宿主里执行 bundle：它只注册工厂，不产生副作用。
		// eslint-disable-next-line no-new-func
		new Function('window', 'document', source)(windowStub, documentStub)
	} finally {
		if (previousWindow === undefined) delete globalThis.window
		else globalThis.window = previousWindow
		if (previousDocument === undefined) delete globalThis.document
		else globalThis.document = previousDocument
	}

	assert.ok(loaded !== null, 'bundle 必须调用 window.__ModuleLoader__.load')
	const services = { slots, sidebarRightTabs }
	return {
		registration: loaded,
		require: (specifier) => (specifier === 'react' ? reactStub : {}),
		services,
		slots,
		tabTypes,
		registrations,
	}
}

test('client bundle：注册工厂、导出 apply/inject', () => {
	const { registration, require } = loadBundle()
	assert.equal(registration.id, 'dev-rules')
	assert.equal(typeof registration.factory, 'function')

	const exports = registration.factory(require)
	assert.equal(typeof exports.apply, 'function')
	assert.deepEqual(exports.inject, ['slots'])
})

test('client bundle：按右侧栏契约注册 tab 类型与 tab 体，并可整体卸载', () => {
	const { registration, require, services, tabTypes, registrations } = loadBundle()
	const exports = registration.factory(require)

	const disposers = []
	const ctx = {
		get(service) {
			return services[service]
		},
		effect(factory) {
			const dispose = factory()
			disposers.push(dispose)
			return dispose
		},
		inject(names, callback) {
			const requested = {}
			for (const name of names) requested[name] = services[name]
			const dispose = callback({
				get(name) {
					return requested[name]
				},
			})
			disposers.push(() => {
				if (typeof dispose === 'function') dispose()
			})
			return dispose
		},
	}
	exports.apply(ctx)

	// 1) tab 类型 + guide 行（右侧栏页面列表里的一行）
	assert.equal(tabTypes.length, 1)
	const type = tabTypes[0]
	assert.equal(type.id, 'dev-rules:panel')
	assert.equal(type.kind, 'dev-rules')
	assert.equal(type.priority, 'extension')
	assert.equal(type.title(), '开发规则')
	assert.equal(type.guide.length, 1)
	assert.equal(type.guide[0].title(), '开发规则')
	assert.equal(typeof type.guide[0].description(), 'string')

	// 2) tab 体：key 必须与 tab 类型的实现 id 一致
	assert.equal(registrations.length, 1)
	assert.equal(registrations[0].name, 'sidebar.right.pane.tab')
	assert.equal(registrations[0].key, 'dev-rules:panel')

	// 3) 左侧栏不再占用 main / sidebar.panellist
	assert.equal(registrations.some((entry) => entry.name === 'main'), false)
	assert.equal(registrations.some((entry) => entry.name === 'sidebar.panellist'), false)

	// 4) 卸载：tab 体与 tab 类型都要撤掉
	for (const dispose of disposers.slice().reverse()) if (typeof dispose === 'function') dispose()
	assert.equal(registrations.length, 0)
	assert.equal(tabTypes.length, 0)
})

test('client bundle：sidebarRightTabs 服务缺席时不报错、只需等它出现', () => {
	const { registration, require, services, tabTypes } = loadBundle()
	const exports = registration.factory(require)

	const ctx = {
		get(service) {
			// 模拟服务比插件晚出现：此刻还没有 sidebarRightTabs
			return service === 'slots' ? services.slots : undefined
		},
		effect(factory) {
			return factory()
		},
		inject(names, callback) {
			return callback({ get: () => undefined })
		},
	}
	assert.doesNotThrow(() => exports.apply(ctx))
	assert.equal(tabTypes.length, 0)
})

test('client 内部件：token 粗估与导入合并（按 id + 标题/正文去重）', () => {
	const { registration, require } = loadBundle()
	const exports = registration.factory(require)
	const { estimateTokens, mergeDocs, injectedSummary, resultSummary } = exports.__internal

	assert.equal(estimateTokens('中文四字'), 4)
	assert.equal(estimateTokens('abcd'), 1)
	assert.equal(estimateTokens(''), 0)

	const base = {
		enabled: true,
		global: [{ id: 'g1', title: 'A', content: 'a', group: '', enabled: true }],
		projects: [{ id: 'p1', path: '/tmp/p', label: '', enabled: true, mode: 'append', rules: [{ id: 'r1', title: 'R', content: 'r', group: '', enabled: true }] }],
	}
	const incoming = {
		enabled: true,
		global: [
			{ id: 'g1', title: 'A', content: 'a', group: '', enabled: true }, // 同 id：跳过
			{ id: 'g9', title: 'A', content: 'a', group: '', enabled: true }, // 同内容：跳过
			{ id: 'g2', title: 'B', content: 'b', group: '流程', enabled: true }, // 新增
		],
		projects: [
			{ id: 'p9', path: '/tmp/p', label: '', enabled: true, mode: 'append', rules: [{ id: 'r2', title: 'R2', content: 'r2', group: '', enabled: true }] },
			{ id: 'p2', path: '/tmp/q', label: '', enabled: true, mode: 'append', rules: [] },
		],
	}
	const merged = mergeDocs(base, incoming)
	assert.equal(merged.global.length, 2)
	assert.equal(merged.global[1].title, 'B')
	assert.equal(merged.projects.length, 2)
	assert.equal(merged.projects[0].rules.length, 2)
	assert.equal(merged.projects[1].path, '/tmp/q')
	// 原文档不被改动
	assert.equal(base.global.length, 1)
	assert.equal(base.projects[0].rules.length, 1)
	// 新条目拿到新 id，不与导入方的 id 冲突
	assert.notEqual(merged.global[1].id, 'g2')

	assert.match(injectedSummary({ injected: '', injectedChars: 0, chars: 0 }), /当前不注入/)
	assert.match(injectedSummary({ injected: 'x', injectedChars: 10, chars: 20, truncated: true, injectedTokens: 3 }), /已截断/)
	assert.match(injectedSummary({ injected: 'x', injectedChars: 10, chars: 10, truncated: false, tokens: 3 }), /约 3 token/)

	// 预览摘要（人话版）
	assert.deepEqual(resultSummary({ injected: '', counts: {}, rules: [] }), ['当前不会注入：没有生效的规则，或总开关被关掉了。'])
	const appended = resultSummary({
		injected: 'x',
		matched: { path: '/tmp/p', label: '博客', mode: 'append' },
		counts: { global: 3, project: 1, suppressed: 0 },
		rules: [{ id: 'a' }],
		chars: 120,
		tokens: 90,
		truncated: false,
	})
	assert.match(appended[0], /命中项目「博客」/)
	assert.match(appended[0], /全局 3 条 \+ 本项目 1 条/)
	assert.match(appended[1], /共 1 条规则 · 约 120 字（约 90 token）/)
	const overridden = resultSummary({
		injected: 'x',
		matched: { path: '/tmp/p', label: '', mode: 'override' },
		counts: { global: 2, project: 1, suppressed: 2 },
		rules: [{ id: 'a' }],
		chars: 10,
		tokens: 8,
		truncated: true,
	})
	assert.match(overridden[0], /\/tmp\/p/)
	assert.match(overridden[1], /挡掉的全局规则：2 条/)
	assert.match(overridden[2], /已截断/)
})
