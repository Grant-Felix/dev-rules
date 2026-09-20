/**
 * 宿主半体的集成冒烟测试：不启动 DSH，用一个最小 ctx 桩驱动 apply()，
 * 验证几件事真的接通了 ——
 *   1. 规则经 `dev_rules_body` 提示变量渲染（section 正文是常量，用户内容
 *      不会被 DSH 的 `{{…}}` 插值扫到）；
 *   2. /dev-rules/* 接口能读 / 存 / 预览 / 列工作区，并挡住跨站与错类型；
 *   3. 保存带 revision，过期返回 409；保存前留 .bak 备份；
 *   4. dev_rules 工具能新增 / 改 / 删规则并落盘，立刻影响注入文本。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply, name, inject } from '../lib/index.js'

/** 最小 ctx 桩：只实现本插件用到的注册面，并记录 disposer。 */
function makeCtx(extra = {}) {
	const disposed = []
	const ctx = {
		logger: { warn() {} },
		sections: [],
		variables: new Map(),
		routes: [],
		registeredTools: [],
		effect(factory) {
			const dispose = factory()
			if (typeof dispose === 'function') disposed.push(dispose)
			return dispose
		},
		systemPrompt: {
			section(section) {
				ctx.sections.push(section)
				return () => {}
			},
			variable(variableName, provider) {
				ctx.variables.set(variableName, provider)
				return () => {}
			},
		},
		webServer: {
			register(route) {
				ctx.routes.push(route)
				return () => {}
			},
		},
		tools: {
			register(tool) {
				ctx.registeredTools.push(tool)
				return () => {}
			},
		},
		get(service) {
			return extra[service]
		},
		disposeAll() {
			while (disposed.length > 0) disposed.pop()()
		},
	}
	return ctx
}

function makeRequest(method, url, body, headers = {}) {
	const merged = { ...headers }
	if (body !== undefined && merged['content-type'] === undefined) merged['content-type'] = 'application/json'
	return {
		method,
		url,
		headers: merged,
		async *[Symbol.asyncIterator]() {
			if (body !== undefined) yield body
		},
	}
}

function makeResponse() {
	return {
		status: 0,
		body: '',
		writeHead(status) {
			this.status = status
		},
		end(chunk) {
			this.body = chunk === undefined ? '' : String(chunk)
		},
	}
}

async function callRoute(ctx, method, url, body, headers) {
	const route = ctx.routes.find((entry) => entry.path === '/dev-rules')
	assert.ok(route !== undefined, '插件应注册 /dev-rules 路由')
	const res = makeResponse()
	await route.handler(makeRequest(method, url, body, headers), res)
	return { status: res.status, payload: res.body === '' ? null : JSON.parse(res.body) }
}

function withHome(t) {
	const home = mkdtempSync(path.join(os.tmpdir(), 'dev-rules-'))
	const previous = process.env.DSH_HOME
	process.env.DSH_HOME = home
	t.after(() => {
		if (previous === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = previous
		rmSync(home, { recursive: true, force: true })
	})
	return home
}

const bodyProvider = (ctx) => {
	const provider = ctx.variables.get('dev_rules_body')
	assert.equal(typeof provider, 'function', '应注册 dev_rules_body 提示变量')
	return provider
}

const cwdAssembly = (cwd) => ({ agent: { session: { header: { cwd } } } })

test('插件身份：name / inject 与约定一致', () => {
	assert.equal(name, 'dev-rules')
	assert.deepEqual(inject, ['webServer', 'systemPrompt', 'tools'])
})

test('注入：section 是常量引用，正文由 dev_rules_body 变量提供', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	const section = ctx.sections.find((entry) => entry.name === 'plugin:dev-rules')
	assert.ok(section !== undefined, '应注册 plugin:dev-rules section')
	assert.equal(section.order, 100)
	// 关键：section 正文必须是常量引用，不能把用户内容塞进会被插值扫描的位置
	assert.equal(section.text, '{{dev_rules_body}}')

	const provider = bodyProvider(ctx)
	assert.equal(provider(cwdAssembly('/tmp/whatever')), '')

	const tool = ctx.registeredTools.find((entry) => entry.name === 'dev_rules')
	await tool.execute({ action: 'add', scope: 'global', title: '提交前跑测试', content: 'npm test 必须绿' })
	assert.match(provider(cwdAssembly('/tmp/other')), /\*\*提交前跑测试\*\*/)

	await tool.execute({ action: 'add', scope: 'project', path: '/tmp/demo-project', title: '本项目用 pnpm', content: '禁止 npm install' })
	const inside = provider(cwdAssembly('/tmp/demo-project/src'))
	assert.match(inside, /本项目用 pnpm/)
	assert.match(inside, /提交前跑测试/)
	assert.doesNotMatch(provider(cwdAssembly('/tmp/elsewhere')), /本项目用 pnpm/)

	// 组装上下文缺 cwd 时只注入全局，绝不猜测目录
	const noCwd = provider({})
	assert.match(noCwd, /提交前跑测试/)
	assert.doesNotMatch(noCwd, /本项目用 pnpm/)

	// 用户规则里的 `{{…}}` 原样保留（不会被插值、更不会打挂模型步）
	await tool.execute({ action: 'add', scope: 'global', title: '模板写法', content: '示例：{{user_name}} 与 {\{bad}' })
	const withBraces = provider(cwdAssembly('/tmp/other'))
	assert.match(withBraces, /\{\{user_name\}\}/)
})

test('注入：软链工作目录经 realpath 回退仍能命中项目规则', async (t) => {
	if (process.platform === 'win32') return
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())
	const provider = bodyProvider(ctx)
	const tool = ctx.registeredTools.find((entry) => entry.name === 'dev_rules')

	const realDir = mkdtempSync(path.join(os.tmpdir(), 'dev-rules-real-'))
	const linkDir = path.join(mkdtempSync(path.join(os.tmpdir(), 'dev-rules-link-')), 'link')
	t.after(() => {
		rmSync(realDir, { recursive: true, force: true })
		rmSync(path.dirname(linkDir), { recursive: true, force: true })
	})
	symlinkSync(realDir, linkDir)

	await tool.execute({ action: 'add', scope: 'project', path: realDir, title: '软链项目规则', content: 'x' })
	// 会话 cwd 走的是软链路径，规则登记的是 realpath → 应通过 realpath 回退命中
	assert.match(provider(cwdAssembly(linkDir)), /软链项目规则/)
})

test('接口：state / workspaces / save / preview / reload 与落盘 + 备份', async (t) => {
	const home = withHome(t)
	const ctx = makeCtx({
		workspaceRegistry: { list: () => [{ path: '/tmp/ws-a', title: '工作区 A' }] },
		sessions: { list: () => [{ header: { cwd: '/tmp/session-cwd' } }] },
	})
	apply(ctx)
	t.after(() => ctx.disposeAll())

	const initial = await callRoute(ctx, 'GET', '/dev-rules/state')
	assert.equal(initial.status, 200)
	assert.equal(initial.payload.meta.file, path.join(home, 'dev-rules.json'))
	assert.equal(initial.payload.meta.backupFile, path.join(home, 'dev-rules.json.bak'))

	const workspaces = await callRoute(ctx, 'GET', '/dev-rules/workspaces')
	assert.deepEqual(
		workspaces.payload.workspaces.map((entry) => entry.path),
		['/tmp/ws-a', '/tmp/session-cwd'],
	)

	const saved = await callRoute(
		ctx,
		'POST',
		'/dev-rules/save',
		JSON.stringify({
			doc: {
				enabled: true,
				global: [{ title: '先读再改', content: '动手前先读完相关文件', group: '流程' }],
				projects: [{ path: '/tmp/proj-x', mode: 'override', rules: [{ title: 'X', content: 'x' }] }],
			},
		}),
	)
	assert.equal(saved.payload.ok, true)
	assert.equal(saved.payload.doc.global[0].group, '流程')
	const firstRevision = saved.payload.meta.revision

	// 预览：带成本统计与被覆盖的全局规则数（此时项目 /tmp/proj-x 还在）
	const preview = await callRoute(
		ctx,
		'POST',
		'/dev-rules/preview',
		JSON.stringify({ path: '/tmp/proj-x/sub' }),
	)
	assert.equal(preview.payload.matched.mode, 'override')
	assert.equal(preview.payload.counts.suppressed, 1)
	assert.ok(preview.payload.chars > 0)
	assert.ok(preview.payload.tokens > 0)
	assert.equal(Array.isArray(preview.payload.rules), true)
	assert.equal(preview.payload.rules[0].title, 'X')

	// 第二次保存：旧版必须留在 .bak 里
	const second = await callRoute(
		ctx,
		'POST',
		'/dev-rules/save',
		JSON.stringify({
			revision: firstRevision,
			doc: { enabled: true, global: [{ title: 'V2', content: '第二版' }], projects: [] },
		}),
	)
	assert.equal(second.payload.ok, true)
	const backup = JSON.parse(readFileSync(path.join(home, 'dev-rules.json.bak'), 'utf8'))
	assert.equal(backup.global[0].title, '先读再改')
	const onDisk = JSON.parse(readFileSync(path.join(home, 'dev-rules.json'), 'utf8'))
	assert.equal(onDisk.global[0].title, 'V2')

	// 用过期 revision 保存：409，不覆盖
	const stale = await callRoute(
		ctx,
		'POST',
		'/dev-rules/save',
		JSON.stringify({ revision: firstRevision, doc: { global: [{ title: '不该写进去', content: 'x' }], projects: [] } }),
	)
	assert.equal(stale.status, 409)
	assert.equal(stale.payload.conflict, true)
	assert.equal(JSON.parse(readFileSync(path.join(home, 'dev-rules.json'), 'utf8')).global[0].title, 'V2')

	const reload = await callRoute(ctx, 'POST', '/dev-rules/reload', '{}')
	assert.equal(reload.payload.meta.revision >= 1, true)
});

test('接口硬化：跨站请求 403、非 JSON 体 415、未知路径 404', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	const crossSite = await callRoute(ctx, 'GET', '/dev-rules/state', undefined, { 'sec-fetch-site': 'cross-site' })
	assert.equal(crossSite.status, 403)

	const otherOrigin = await callRoute(ctx, 'POST', '/dev-rules/save', JSON.stringify({ doc: { global: [], projects: [] } }), {
		origin: 'http://evil.example',
		host: '127.0.0.1:3080',
	})
	assert.equal(otherOrigin.status, 403)

	const sameOrigin = await callRoute(ctx, 'POST', '/dev-rules/save', JSON.stringify({ doc: { global: [], projects: [] } }), {
		origin: 'http://127.0.0.1:3080',
		host: '127.0.0.1:3080',
		'sec-fetch-site': 'same-origin',
	})
	assert.equal(sameOrigin.status, 200)

	const wrongType = await callRoute(ctx, 'POST', '/dev-rules/save', 'doc=x', { 'content-type': 'text/plain' })
	assert.equal(wrongType.status, 415)

	const missing = await callRoute(ctx, 'GET', '/dev-rules/nope')
	assert.equal(missing.status, 404)
});

test('dev_rules 工具：list / update / remove 与错误分支', async (t) => {
	withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())
	const tool = ctx.registeredTools.find((entry) => entry.name === 'dev_rules')

	assert.equal((await tool.execute({ action: 'add' })).ok, false)

	const added = await tool.execute({ action: 'add', title: '约定 A', content: '正文 A', group: '流程' })
	assert.equal(added.ok, true)
	const id = added.data

	const listed = await tool.execute({ action: 'list', path: '/tmp/none' })
	assert.match(listed.data, /约定 A/)
	assert.match(listed.data, /#流程/)
	assert.match(listed.data, new RegExp(id))

	const updated = await tool.execute({ action: 'update', id, enabled: false, group: '安全' })
	assert.equal(updated.ok, true)
	const afterDisable = await tool.execute({ action: 'list', path: '/tmp/none' })
	assert.match(afterDisable.data, /停用/)
	assert.match(afterDisable.data, /#安全/)

	const removed = await tool.execute({ action: 'remove', id })
	assert.equal(removed.ok, true)
	assert.doesNotMatch((await tool.execute({ action: 'list', path: '/tmp/none' })).data, /约定 A/)

	assert.equal((await tool.execute({ action: 'update', id: 'nope' })).ok, false)
	assert.equal((await tool.execute({ action: 'remove' })).ok, false)
	assert.equal((await tool.execute({ action: 'unknown' })).ok, false)
})

test('规则文件被外部改动：监听/轮询之外还有 reload 接口兜底', async (t) => {
	const home = withHome(t)
	const ctx = makeCtx()
	apply(ctx)
	t.after(() => ctx.disposeAll())

	// 模拟外部写入（绕过插件 API），再调 reload 让它生效
	const { writeFileSync } = await import('node:fs')
	writeFileSync(path.join(home, 'dev-rules.json'), JSON.stringify({ global: [{ title: '外部规则', content: 'x' }] }), 'utf8')
	const reload = await callRoute(ctx, 'POST', '/dev-rules/reload', '{}')
	assert.equal(reload.payload.doc.global[0].title, '外部规则')
	assert.equal(existsSync(path.join(home, 'dev-rules.json')), true)
})
