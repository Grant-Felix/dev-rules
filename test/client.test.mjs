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
		// 面板用 layout effect 同步 ref（被动 effect 会被排成宏任务，可能晚于轮询 timer）
		useLayoutEffect: () => {},
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
	// 不是写死某个字符串，而是与包名对齐：DSH 的客户端模块图按包名索引，
	// 注册 id 与包名不一致时启动会报「Failed to load plugins：loaded without
	// registering "<包名>" via __ModuleLoader__.load」。包名一改这条就必须跟着改 ——
	// 曾经因为漏改这一处，一次重启直接把界面打成「插件加载失败」。
	const manifest = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'))
	assert.equal(registration.id, manifest.name)
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

test('client 内部件：筛选行显示判定（规则虽少、筛选仍生效时必须保留控件）', () => {
	const { registration, require } = loadBundle()
	const exports = registration.factory(require)
	const { shouldShowFilters } = exports.__internal

	assert.equal(shouldShowFilters(7, '', ''), true, '规则多于 6 条就显示')
	assert.equal(shouldShowFilters(6, '', ''), false, '6 条及以下不显示')
	// 规则数掉下来但条件还生效：控件必须留着，否则规则被静默筛掉且无法清除
	assert.equal(shouldShowFilters(6, 'npm', ''), true)
	assert.equal(shouldShowFilters(0, '', '__none__'), true)
	assert.equal(shouldShowFilters(3, '', '依赖'), true)
	assert.equal(shouldShowFilters(3, '   ', ''), false, '只有空白字符不算筛选条件')
})

test('client 内部件：Ctrl/Cmd+S 放行判定与主动作按钮同护栏', () => {
	const { registration, require } = loadBundle()
	const exports = registration.factory(require)
	const { canShortcutSave } = exports.__internal

	assert.equal(canShortcutSave(false, true), true, '有未保存改动、且不在保存中：放行')
	// 这两条是真问题所在：无改动时保存会冲掉 .bak 里的「上一版」，保存中再按则是并发写
	assert.equal(canShortcutSave(false, false), false, '没有未保存改动时不该发起保存')
	assert.equal(canShortcutSave(true, true), false, '保存进行中不该重复发起')
	assert.equal(canShortcutSave(true, false), false)
})

test('client bundle：「放弃修改并重新载入」走磁盘重读接口（源码级守卫）', () => {
	// 这条修复的全部内容就是「显式动作打到哪个接口」，而组件在 Node 里渲染不了
	// （react 桩的 createElement 返回 null，effect 也不会跑），只能对着源码钉住接线：
	// 必须真的向 /reload 发 POST（文件头的注释里提到 /reload 不算数），
	// 且那个按钮必须以 fromDisk=true 调 load。
	const source = readFileSync(bundlePath, 'utf8')
	assert.match(source, /postJson\('\/reload'/, '显式重载必须调用宿主的 /reload 接口')
	assert.match(source, /load\(true\)/, '「放弃修改并重新载入」按钮必须要求从磁盘读')
})

test('client 内部件：上限快照与卡片体量标签', () => {
	const { registration, require } = loadBundle()
	const exports = registration.factory(require)
	const { limitsOf, sizeLabel } = exports.__internal

	// 上限只有一处出处（宿主随 meta 下发）；宿主没给就留空，不在这里复制常量
	assert.deepEqual(limitsOf({ limits: { title: 120, group: 60, content: 4000, rules: 300 } }), {
		title: 120,
		group: 60,
		content: 4000,
		rules: 300,
	})
	const unknown = { title: undefined, group: undefined, content: undefined, rules: undefined }
	assert.deepEqual(limitsOf(null), unknown)
	assert.deepEqual(limitsOf({}), unknown)
	assert.deepEqual(limitsOf({ limits: { content: 0, title: -1, group: 'x', rules: Number.NaN } }), unknown)

	// 卡片平常只报体量；某一栏顶到上限时要把上限写出来（maxLength 什么都不说）
	assert.equal(sizeLabel({ title: 'A', content: 'bc' }, {}), '约 3 字')
	assert.equal(sizeLabel({ title: 'A', content: 'bc' }, { title: 120, content: 4000 }), '约 3 字')
	assert.equal(sizeLabel({ title: 'T'.repeat(120), content: 'c' }, { title: 120, content: 4000 }), '约 121 字（标题上限 120）')
	assert.equal(sizeLabel({ title: 'a', content: 'c'.repeat(4000) }, { title: 120, content: 4000 }), '约 4001 字（正文上限 4000）')
	assert.equal(
		sizeLabel({ title: 'T'.repeat(120), content: 'c'.repeat(4000) }, { title: 120, content: 4000 }),
		'约 4120 字（标题上限 120 / 正文上限 4000）',
	)
})

test('client 内部件：保存前拦下会被宿主静默丢掉的内容', () => {
	const { registration, require } = loadBundle()
	const exports = registration.factory(require)
	const { validateDoc } = exports.__internal

	const limits = { title: 120, group: 60, content: 4000, rules: 3 }
	const doc = (global, projects) => ({ enabled: true, global, projects })
	const rule = (title, content) => ({ id: 'r' + title + content, title, content, group: '', enabled: true })

	assert.equal(validateDoc(doc([rule('A', 'a')], []), limits), null, '正常文档放行')

	// 空白项目目录：既有行为，切到项目页签
	const blankPath = validateDoc(doc([], [{ id: 'p', path: '  ', rules: [] }]), limits)
	assert.equal(blankPath.tab, 'projects')
	assert.match(blankPath.text, /还没填目录/)

	// 空规则会被宿主的 normalizeRules 直接丢掉：必须先在面板拦下，与空白目录同级
	const blankGlobal = validateDoc(doc([rule('', ''), rule('A', 'a')], []), limits)
	assert.equal(blankGlobal.tab, 'global')
	assert.match(blankGlobal.text, /有 1 条规则的标题和正文都是空的/)
	const blankProject = validateDoc(doc([], [{ id: 'p', path: '/tmp/p', rules: [rule('  ', '')] }]), limits)
	assert.equal(blankProject.tab, 'projects')
	assert.match(blankProject.text, /有 1 条规则/)

	// 超过每列表上限：多余的会被丢掉
	const overGlobal = validateDoc(doc([rule('A', 'a'), rule('B', 'b'), rule('C', 'c'), rule('D', 'd')], []), limits)
	assert.equal(overGlobal.tab, 'global')
	assert.match(overGlobal.text, /全局规则有 4 条，超过上限 3 条/)
	const overProject = validateDoc(
		doc([], [{ id: 'p', path: '/tmp/p', label: '博客', rules: [rule('A', 'a'), rule('B', 'b'), rule('C', 'c'), rule('D', 'd')] }]),
		limits,
	)
	assert.equal(overProject.tab, 'projects')
	assert.match(overProject.text, /项目「博客」有 4 条规则，超过上限 3 条/)
})

test('client bundle：顶部吸顶条（源码级守卫）', () => {
	// sticky 是纯样式，Node 里既没有 DOM 也没有布局可测，只能对着源码钉住：
	// 这条守卫防的是「有人把 position: sticky 或底色删掉」—— README 两处都写了
	// 顶部吸顶条，而面板正是靠它保证长列表滚下去后主动作还在。
	const source = readFileSync(bundlePath, 'utf8')
	const block = /\.dr_top\s*\{([^}]*)\}/.exec(source)
	assert.ok(block !== null, '应存在 .dr_top 样式块')
	assert.match(block[1], /position:\s*sticky/, '.dr_top 必须吸顶')
	assert.match(block[1], /top:\s*0/, '吸顶条要贴在滚动容器顶部')
	const background = /background:\s*([^;]+);/.exec(block[1])
	assert.ok(background !== null, '吸顶条要有底色，否则滚动内容会从它底下透出来')
	assert.notEqual(background[1].trim(), 'transparent', '底色不能是 transparent')
})

test('client 内部件：revision 单调性判定（旧响应不许把状态倒回去）', () => {
	const { registration, require } = loadBundle()
	const exports = registration.factory(require)
	const { isNewerRevision } = exports.__internal

	assert.equal(isNewerRevision(5, 4), true)
	assert.equal(isNewerRevision(4, 4), false, '同一个 revision 不算新状态')
	// 保存之前发出的轮询请求、响应后到：照收会把刚保存的 doc 与 revision 一起倒回去
	assert.equal(isNewerRevision(3, 4), false)
	assert.equal(isNewerRevision(1, 0), true)
	assert.equal(isNewerRevision(Number.NaN, 4), false)
	assert.equal(isNewerRevision(undefined, 4), false)
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

// ---------------------------------------------------------------- 插件自更新

/** 市场 UPDATE-API-v1 的实测文档形状（capabilities 与 updates 的 package）。 */
const CAPABILITIES = {
	schema: 'dsh-market/update-api/v1',
	apiVersion: 1,
	stability: 'beta',
	marketVersion: '0.9.0',
	profile: 'web',
	bootId: 'boot-1',
	runtime: 'web',
	features: { check: true, update: true, progress: true, rollback: true, restart: true, updatesSummary: true },
	restart: { supported: true, managedBy: 'market', supervisor: null, debugger: null },
	operationRetention: 'current-process',
	operationLimit: 50,
	endpoints: {
		updates: '/dsh-market/api/v1/updates',
		updatesSummary: '/dsh-market/api/v1/updates/summary',
		operations: '/dsh-market/api/v1/operations',
		rollback: '/dsh-market/api/v1/rollback',
		restart: '/dsh-market/api/v1/restart',
	},
}

const SHA_OLD = '0b8a9b7c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60'
const SHA_NEW = 'd054f3d1a2b3c4d5e6f708192a3b4c5d6e7f8091'
const CAPS = { rollback: true, restart: true }
const NO_RESTART = { rollback: false, restart: false }
const BEHIND = {
	name: 'dsh-dev-rules',
	source: 'github',
	installedVersion: SHA_OLD,
	latestVersion: SHA_NEW,
	updateAvailable: true,
	channelSwitch: null,
}

test('client 内部件：短 sha 与更新中按钮的百分比', () => {
	const { registration, require } = loadBundle()
	const { shortVersion, updatingLabel } = registration.factory(require).__internal

	// git 来源给的是 40 位 commit sha：提示里只放前 7 位
	assert.equal(shortVersion(SHA_NEW), 'd054f3d')
	assert.equal(shortVersion('0b8a9b7'), '0b8a9b7')
	// npm 来源是语义化版本：一律截断会把 1.2.0-beta.1 截成 1.2.0-b
	assert.equal(shortVersion('0.4.2'), '0.4.2')
	assert.equal(shortVersion('1.2.0-beta.1'), '1.2.0-beta.1')
	assert.equal(shortVersion('abc'), 'abc', '不足 7 位就不像 sha，原样用')
	assert.equal(shortVersion(''), '')
	assert.equal(shortVersion(undefined), '')
	assert.equal(shortVersion(null), '')

	assert.equal(updatingLabel({ progress: { percent: 42 } }), '更新中… 42%')
	assert.equal(updatingLabel({ progress: { percent: 0 } }), '更新中… 0%')
	assert.equal(updatingLabel({ progress: { percent: 42.6 } }), '更新中… 43%')
	assert.equal(updatingLabel({ progress: { percent: 250 } }), '更新中… 100%', '越界值也不显示成 250%')
	assert.equal(updatingLabel({ progress: { percent: -5 } }), '更新中… 0%')
	// 市场没给百分比（progress.percent 为 null）时不编一个出来
	assert.equal(updatingLabel({ progress: { percent: null } }), '更新中…')
	assert.equal(updatingLabel({ progress: {} }), '更新中…')
	assert.equal(updatingLabel({}), '更新中…')
	assert.equal(updatingLabel(null), '更新中…')
})

test('client 内部件：更新终态判定（不认识的状态也当结束）', () => {
	const { registration, require } = loadBundle()
	const { isOperationTerminal, updateNotice } = registration.factory(require).__internal

	assert.equal(isOperationTerminal({ state: 'queued' }), false)
	assert.equal(isOperationTerminal({ state: 'running' }), false)
	for (const state of ['succeeded', 'failed', 'cancelled', 'rolled-back']) {
		assert.equal(isOperationTerminal({ state }), true, state + ' 是终态')
	}
	// 遇到没见过的状态还接着 1.5 秒一轮问下去，会把市场问成永动机
	assert.equal(isOperationTerminal({ state: 'wat' }), true)
	assert.equal(isOperationTerminal({}), true)
	assert.equal(isOperationTerminal(null), true)
	// 没有终态记录时，判定就是「按有没有新版本出提示」
	assert.equal(updateNotice(BEHIND, null, CAPS).tone, 'update')
})

test('client 内部件：市场能力探测（探测不到就整块不渲染）', () => {
	const { registration, require } = loadBundle()
	const { capabilitiesOf } = registration.factory(require).__internal

	assert.deepEqual(capabilitiesOf(CAPABILITIES), { rollback: true, restart: true })
	// 重启按钮只认 restart.supported（文档明确要求特性探测）
	assert.deepEqual(capabilitiesOf({ ...CAPABILITIES, restart: { supported: false, managedBy: 'desktop-host' } }), {
		rollback: true,
		restart: false,
	})
	assert.deepEqual(capabilitiesOf({ ...CAPABILITIES, features: { update: true, rollback: false } }), { rollback: false, restart: true })

	// 探测不到：没装市场、响应为空、不是本契约的 schema、能力位说不支持更新 —— 全部当作没有入口
	assert.equal(capabilitiesOf(null), null)
	assert.equal(capabilitiesOf({}), null)
	assert.equal(capabilitiesOf('<!doctype html>'), null)
	assert.equal(capabilitiesOf({ ...CAPABILITIES, schema: 'dsh-market/update-api/v2' }), null)
	assert.equal(capabilitiesOf({ ...CAPABILITIES, features: { update: false } }), null)
	assert.equal(capabilitiesOf({ ...CAPABILITIES, features: {} }), null)
})

test('client 内部件：更新提示分支（无更新 / 有更新 / 进行中 / 成功需重启）', () => {
	const { registration, require } = loadBundle()
	const { updateNotice } = registration.factory(require).__internal

	// 1) 没更新：什么都不显示（绝不常驻）
	assert.equal(updateNotice({ ...BEHIND, updateAvailable: false, latestVersion: SHA_OLD }, null, CAPS), null)
	assert.equal(updateNotice(null, null, CAPS), null)
	assert.equal(updateNotice(undefined, undefined, CAPS), null)
	// 市场探测不到：整块不渲染
	assert.equal(updateNotice(BEHIND, null, null), null)
	assert.equal(updateNotice(BEHIND, { state: 'running' }, null), null)

	// 2) 有更新：短 sha 两头对照 + 一个「更新」按钮
	const offer = updateNotice(BEHIND, null, CAPS)
	assert.equal(offer.tone, 'update')
	assert.equal(offer.text, '本插件有新版本：0b8a9b7 → d054f3d')
	assert.deepEqual(offer.buttons, [{ id: 'update', label: '更新' }])

	// 3) 更新中：按钮禁用，有百分比就带上
	const busy = updateNotice(BEHIND, { state: 'running', progress: { percent: 42 } }, CAPS)
	assert.equal(busy.tone, 'busy')
	assert.deepEqual(busy.buttons, [{ id: 'update', label: '更新中… 42%', disabled: true }])
	assert.deepEqual(updateNotice(BEHIND, { state: 'queued', progress: { percent: null } }, CAPS).buttons, [
		{ id: 'update', label: '更新中…', disabled: true },
	])

	// 4) 成功且要重启/刷新：告诉用户重启才生效，可重启时给按钮
	const succeeded = {
		operationId: 'boot-1-update-1',
		state: 'succeeded',
		beforeVersion: SHA_OLD,
		installedVersion: SHA_NEW,
		outcome: { refreshRequired: false, restartRequired: true, rollback: { available: false, state: 'unavailable' } },
	}
	const done = updateNotice(BEHIND, succeeded, CAPS)
	assert.equal(done.tone, 'ok')
	assert.equal(done.text, '已更新到 d054f3d，重启 profile 后生效。')
	assert.deepEqual(done.buttons, [{ id: 'restart', label: '重启 profile', variant: 'primary' }])
	// 市场说这台机器不能重启：提示照给，但绝不留一个按不动的重启按钮
	const doneNoRestart = updateNotice(BEHIND, succeeded, NO_RESTART)
	assert.equal(doneNoRestart.text, '已更新到 d054f3d，重启 profile 后生效。')
	assert.deepEqual(doneNoRestart.buttons, [])
	// refreshRequired 同样要用户动手
	const refreshed = updateNotice(BEHIND, { ...succeeded, outcome: { refreshRequired: true, restartRequired: false } }, CAPS)
	assert.equal(refreshed.text, '已更新到 d054f3d，重启 profile 后生效。')
	// 当场就生效（既不用重启也不用刷新）：没有要用户做的事，吸顶区让出来
	assert.equal(updateNotice(BEHIND, { ...succeeded, outcome: { restartRequired: false, refreshRequired: false } }, CAPS), null)
	// 回滚完成后市场把记录标成 rolled-back + 需要重启：文案得说回滚，而不是「已更新」
	const rolledBack = updateNotice(BEHIND, { ...succeeded, state: 'rolled-back' }, CAPS)
	assert.equal(rolledBack.text, '已回滚到 d054f3d，重启 profile 后生效。')
	// cancelled 没有可看的终态内容：落回「有新版本」，把更新按钮还给用户
	assert.equal(updateNotice(BEHIND, { state: 'cancelled' }, CAPS).text, '本插件有新版本：0b8a9b7 → d054f3d')
})

test('client 内部件：更新失败（市场文案原样、按 retryable 给重试、回滚受能力位约束）', () => {
	const { registration, require } = loadBundle()
	const { updateNotice } = registration.factory(require).__internal

	// 实测的 AGENTS_RUNNING 终态：message 是市场写给用户看的现成文案，面板不改写
	const agentsBusy = {
		operationId: 'boot-1-update-1',
		state: 'failed',
		failure: { code: 'AGENTS_RUNNING', message: '有 agent 正在运行，等这轮结束再试。', retryable: true },
		outcome: { restartRequired: false, refreshRequired: false, rollback: { available: false, state: 'unavailable', detail: null } },
	}
	const failed = updateNotice(BEHIND, agentsBusy, CAPS)
	assert.equal(failed.tone, 'error')
	assert.equal(failed.text, '有 agent 正在运行，等这轮结束再试。')
	assert.deepEqual(failed.buttons, [{ id: 'retry', label: '重试' }])

	// 不可重试（例如 DOWNGRADE_DETECTED）：不给重试按钮，但失败原因照给
	const permanent = updateNotice(
		BEHIND,
		{ ...agentsBusy, failure: { code: 'DOWNGRADE_DETECTED', message: '目标版本比当前版本旧。', retryable: false } },
		CAPS,
	)
	assert.equal(permanent.text, '目标版本比当前版本旧。')
	assert.deepEqual(permanent.buttons, [])

	// 有回滚点、且市场能力位说支持回滚时才给「回滚」
	const rollbackReady = { ...agentsBusy, failure: { code: 'UPDATE_FAILED', message: '装包失败。', retryable: false }, outcome: { rollback: { available: true, state: 'available', detail: null } } }
	assert.deepEqual(updateNotice(BEHIND, rollbackReady, CAPS).buttons, [{ id: 'rollback', label: '回滚' }])
	assert.deepEqual(updateNotice(BEHIND, rollbackReady, NO_RESTART).buttons, [], '能力位说不能回滚就不给按钮')
	assert.deepEqual(updateNotice(BEHIND, { ...rollbackReady, operationId: undefined }, CAPS).buttons, [], '不知道是哪次操作就没法回滚')

	// 失败时优先展示失败本身，而不是顺手把「有新版本」摆出来
	assert.equal(failed.tone, 'error')
	// 市场连 failure 都没给：不编造原因，只说没给
	assert.equal(updateNotice(BEHIND, { state: 'failed' }, CAPS).text, '更新失败，插件市场没有给出原因。')
})

test('client 内部件：请求失败收敛成一条提示（市场原文优先）', () => {
	const { registration, require } = loadBundle()
	const { failedOperation } = registration.factory(require).__internal

	// 市场给了 failure（例如 409 的 OPERATION_BUSY）：文案与 retryable 都原样采信
	assert.deepEqual(
		failedOperation({ failure: { code: 'OPERATION_BUSY', message: '另一个更新正在进行。', retryable: true } }, '兜底', false),
		{ state: 'failed', failure: { message: '另一个更新正在进行。', retryable: true } },
	)
	// 市场说不重试，调用方的兜底 retryable 不能把它翻过来
	assert.equal(failedOperation({ failure: { message: '插件没有装在这个 profile 里。', retryable: false } }, '兜底', true).failure.retryable, false)
	// 只有 error 的那种 4xx：文案同样是市场原文，retryable 由调用方定
	assert.deepEqual(failedOperation({ error: 'plugin is not installed' }, '兜底', false), {
		state: 'failed',
		failure: { message: 'plugin is not installed', retryable: false },
	})
	// 实测中市场的重启路由把原因包在 result 里：能取到就用它的原文，别退化成「HTTP 403」
	assert.equal(
		failedOperation({ schema: 'dsh-market/update-api/v1', result: { error: 'self-restart is disabled for this host' } }, '兜底', false).failure.message,
		'self-restart is disabled for this host',
	)
	// 网络层失败（连响应体都没有）：只能用面板的兜底文案
	assert.deepEqual(failedOperation(undefined, '更新请求没有发出去：fetch failed', true), {
		state: 'failed',
		failure: { message: '更新请求没有发出去：fetch failed', retryable: true },
	})
	assert.equal(failedOperation(null, '更新请求没有发出去：x', true).state, 'failed')
	// 什么都没有：不造一条空提示出来
	assert.equal(failedOperation(null, '', true), null)
	assert.equal(failedOperation({ failure: { message: '' } }, '', true), null)
	// 收敛出来的东西就是 updateNotice 认得的那种「失败操作」
	const { updateNotice } = registration.factory(require).__internal
	assert.equal(updateNotice(BEHIND, failedOperation(null, '更新请求没有发出去：x', true), CAPS).text, '更新请求没有发出去：x')
})

test('client 内部件：请求失败的兜底文案分得清「没发出去」与「被市场拒了」', () => {
	const { registration, require } = loadBundle()
	const { failureMessage } = registration.factory(require).__internal

	// 网络层失败：请求压根没到市场
	const offline = new TypeError('fetch failed')
	assert.equal(failureMessage(offline, '更新'), '没能连上插件市场，更新没有执行：fetch failed')
	// 市场收到了但拒绝：说成「没发出去」会把排查方向带到网络上去
	const rejected = new Error('plugin is not installed')
	rejected.status = 404
	assert.equal(failureMessage(rejected, '更新'), '插件市场拒绝了这次更新（HTTP 404）：plugin is not installed')
	// 市场没给原因时别把「HTTP 404」重复两遍
	const bare = new Error('HTTP 403')
	bare.status = 403
	assert.equal(failureMessage(bare, '重启'), '插件市场拒绝了这次重启（HTTP 403）。')
	assert.equal(failureMessage('爆了', '回滚'), '没能连上插件市场，回滚没有执行：爆了')
})

test('client 内部件：从实测响应体里取 package / operation（照契约的形状解析）', () => {
	const { registration, require } = loadBundle()
	const { updateStatusOf, operationOf, capabilitiesOf } = registration.factory(require).__internal

	// 下面三份是照本机 dshmarket（UPDATE-API-v1）实测响应抄下来的形状
	const status = updateStatusOf({
		schema: 'dsh-market/update-api/v1',
		package: { name: 'dsh-dev-rules', source: 'github', installedVersion: SHA_OLD, latestVersion: SHA_NEW, updateAvailable: true, channelSwitch: null },
	})
	assert.equal(status.updateAvailable, true)
	assert.equal(status.installedVersion, SHA_OLD)

	const operation = operationOf({
		schema: 'dsh-market/update-api/v1',
		operation: {
			schema: 'dsh-market/update-api/v1',
			operationId: '12227-1789986459219-update-1',
			kind: 'update',
			packageName: 'dsh-dev-rules',
			state: 'running',
			createdAt: 1,
			startedAt: 2,
			finishedAt: null,
			beforeVersion: SHA_OLD,
			installedVersion: SHA_OLD,
			progress: { phase: null, done: 0, total: null, percent: null, currentPackage: null, detail: null, downloaded: null, size: null },
			outcome: { refreshRequired: false, restartRequired: false, rollback: { available: false, state: 'unavailable', detail: null } },
			failure: null,
		},
	})
	assert.equal(operation.operationId, '12227-1789986459219-update-1')
	assert.equal(operation.state, 'running')

	// 形状不对（出错页、别的服务、空响应体）时一律当没有，别把垃圾往提示里送
	assert.equal(updateStatusOf(null), null)
	assert.equal(updateStatusOf({ package: null }), null)
	assert.equal(updateStatusOf({ package: [] }), null)
	assert.equal(operationOf({ operation: 'running' }), null)
	assert.equal(operationOf(undefined), null)

	// 实测的 capabilities：解析出来要能开重启按钮
	assert.deepEqual(capabilitiesOf(CAPABILITIES), { rollback: true, restart: true })
})

test('client bundle：更新只用市场公开的 UPDATE-API-v1（源码级守卫）', () => {
	// 组件在 Node 里渲染不了（react 桩的 createElement 返回 null），接口接线只能对着源码钉
	const source = readFileSync(bundlePath, 'utf8')
	assert.match(source, /const MARKET_API = '\/dsh-market\/api\/v1'/, '市场接口前缀是契约的一部分')
	assert.match(source, /fetchMarket\('\/capabilities'\)/, '能力探测必须先做')
	assert.match(source, /fetchMarket\('\/updates\?name='/)
	assert.match(source, /marketPost\('\/updates', \{ packageName: PACKAGE_NAME \}\)/)
	assert.match(source, /fetchMarket\('\/operations\?operationId='/)
	assert.match(source, /marketPost\('\/rollback', \{ operationId \}\)/)
	assert.match(source, /marketPost\('\/restart', \{\}\)/)
	// 不碰市场的旧私有路由，也不自己装包：安装算法与回滚点只该有市场那一份
	assert.equal(source.includes('/dsh-market/update'), false, '不得调用市场的旧私有路由')
	assert.equal(/child_process|\bspawn\b|execSync/.test(source), false, '不自己装包')
	// 只有用户主动点的「检查更新」才跳过市场缓存
	assert.equal((source.match(/force=1/g) || []).length, 1)
	assert.match(source, /check\(false\)/, '面板挂载时走市场缓存，别每次开面板都打网络')
	assert.match(source, /update\.run\('check'\)/, '「更多（折叠）」里的「检查更新」接的是一次强制检查')
})

test('client bundle：更新条只在有内容时渲染、重启前必须确认（源码级守卫）', () => {
	const source = readFileSync(bundlePath, 'utf8')
	// 「绝不常驻」的接线：notice 为 null（没更新、也没在更新、也没刚失败）时整块不渲染
	assert.match(source, /notice === null \? null : h\(UpdateBar, \{ notice, onAction: update\.run \}\)/)
	// 只有市场上真说 updateAvailable 才走「有新版本」这条出提示的路
	assert.match(source, /status\.updateAvailable !== true\) return null/)
	// 重启会掐断当前会话：点了必须过 window.confirm
	assert.match(source, /action === 'restart'\)\s*\{\s*if \(!window\.confirm\(/)
	// 轮询到终态即停：定时器随 effect 清掉
	assert.match(source, /if \(isOperationTerminal\(next\)\) \{\s*setOperationId\(null\)/)
	assert.match(source, /clearInterval\(timer\)/)
})
