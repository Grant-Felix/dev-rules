import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
	MAX_SECTION_CHARS,
	containsPath,
	countMarkdownRules,
	effectiveRules,
	emptyDoc,
	estimateTokens,
	groupNames,
	matchProject,
	normalizePath,
	parseMarkdownDoc,
	renderRules,
	ruleSize,
	sanitizeDoc,
	summarizeDoc,
	toMarkdownDoc,
} from '../lib/rules.js'

const posix = (value) => path.sep === '/' ? value : value

test('normalizePath：展开 ~、补全绝对路径、去掉尾部分隔符', () => {
	assert.equal(normalizePath('~'), os.homedir())
	assert.equal(normalizePath('~/项目/foo/'), path.join(os.homedir(), '项目/foo'))
	assert.equal(normalizePath('/tmp/a/b/'), '/tmp/a/b')
	assert.equal(normalizePath(''), '')
	assert.equal(normalizePath('   '), '')
	assert.equal(normalizePath('rel/dir', '/tmp/base'), '/tmp/base/rel/dir')
})

test('sanitizeDoc：任何垃圾输入都收敛成合法文档', () => {
	const doc = sanitizeDoc(null)
	assert.deepEqual(doc, emptyDoc())

	const messy = sanitizeDoc({
		enabled: false,
		global: [
			null,
			{ title: '  ', content: '   ' },
			{ title: '  提交前跑测试  ', content: 'npm test 必须绿  \n\n' },
			{ id: 'dup', title: 'A', content: 'x' },
			{ id: 'dup', title: 'B', content: 'y' },
		],
		projects: [
			{ path: '' },
			{ path: '/tmp/proj-a', mode: 'nonsense', rules: [{ content: '只有正文' }] },
			{ path: '/tmp/proj-a', rules: [] },
			{ path: '/tmp/proj-b', mode: 'override', enabled: false, label: '  B  ' },
		],
	})
	assert.equal(messy.enabled, false)
	assert.equal(messy.global.length, 3)
	assert.equal(messy.global[0].title, '提交前跑测试')
	assert.equal(messy.global[0].content, 'npm test 必须绿')
	assert.equal(messy.global[0].enabled, true)
	// 重复 id 被改写；两条都保留
	assert.notEqual(messy.global[1].id, messy.global[2].id)
	// 空路径项目被丢弃，重复路径只留一条
	assert.equal(messy.projects.length, 2)
	assert.equal(messy.projects[0].path, posix('/tmp/proj-a'))
	assert.equal(messy.projects[0].mode, 'append')
	// 正文兜底成标题
	assert.equal(messy.projects[0].rules[0].title, '只有正文')
	assert.equal(messy.projects[1].mode, 'override')
	assert.equal(messy.projects[1].enabled, false)
	assert.equal(messy.projects[1].label, 'B')
})

test('matchProject：取最长前缀，且不跨目录边界', () => {
	const doc = sanitizeDoc({
		projects: [
			{ path: '/tmp/proj', rules: [] },
			{ path: '/tmp/proj/sub', rules: [] },
			{ path: '/tmp/proj-other', enabled: false, rules: [] },
		],
	})
	assert.equal(matchProject(doc, '/tmp/proj/sub/deep').path, posix('/tmp/proj/sub'))
	assert.equal(matchProject(doc, '/tmp/proj/other').path, posix('/tmp/proj'))
	assert.equal(matchProject(doc, '/tmp/proj').path, posix('/tmp/proj'))
	// /tmp/projabc 不属于 /tmp/proj
	assert.equal(matchProject(doc, '/tmp/projabc'), null)
	// 停用的项目不参与匹配
	assert.equal(matchProject(doc, '/tmp/proj-other/x'), null)
	assert.equal(matchProject(doc, ''), null)
})

test('effectiveRules：追加与覆盖两种模式', () => {
	const doc = sanitizeDoc({
		global: [{ id: 'g1', title: 'G1', content: 'g1' }, { id: 'g2', title: 'G2', content: 'g2', enabled: false }],
		projects: [
			{ path: '/tmp/append', mode: 'append', rules: [{ id: 'p1', title: 'P1', content: 'p1' }] },
			{ path: '/tmp/override', mode: 'override', rules: [{ id: 'p2', title: 'P2', content: 'p2' }] },
		],
	})

	const appended = effectiveRules(doc, '/tmp/append/src')
	assert.deepEqual(appended.rules.map((rule) => rule.id), ['g1', 'p1'])
	assert.equal(appended.override, false)
	assert.equal(appended.project.path, posix('/tmp/append'))

	const overridden = effectiveRules(doc, '/tmp/override/src')
	assert.deepEqual(overridden.rules.map((rule) => rule.id), ['p2'])
	assert.equal(overridden.override, true)
	assert.equal(overridden.globalRules.length, 1)

	// 未命中项目 → 只有全局
	const plain = effectiveRules(doc, '/tmp/elsewhere')
	assert.deepEqual(plain.rules.map((rule) => rule.id), ['g1'])
	assert.equal(plain.project, null)
})

test('renderRules：无生效规则就返回空串（等于不注入）', () => {
	assert.equal(renderRules(emptyDoc(), '/tmp/x'), '')
	assert.equal(renderRules(sanitizeDoc({ enabled: false, global: [{ title: 'A', content: 'a' }] }), '/tmp/x'), '')
	// 命中项目但项目规则为空、全局被覆盖 → 也不注入
	const overrideEmpty = sanitizeDoc({
		global: [{ title: 'A', content: 'a' }],
		projects: [{ path: '/tmp/x', mode: 'override', rules: [] }],
	})
	assert.equal(renderRules(overrideEmpty, '/tmp/x'), '')
})

test('renderRules：文本包含全局与项目规则、标注来源', () => {
	const doc = sanitizeDoc({
		global: [{ title: '全局规矩', content: '第一行\n第二行' }],
		projects: [{ path: '/tmp/proj', label: '示例项目', rules: [{ title: '项目规矩', content: '只管本项目' }] }],
	})
	const text = renderRules(doc, '/tmp/proj/src')
	assert.match(text, /# 项目开发规则/)
	assert.match(text, /## 全局规则/)
	assert.match(text, /## 项目规则/)
	assert.match(text, /\*\*全局规矩\*\*/)
	assert.match(text, /\*\*项目规矩\*\*/)
	assert.match(text, /适用项目：示例项目/)
	assert.match(text, /第二行/)
	// 未命中项目时不出现项目段落
	const outside = renderRules(doc, '/tmp/none')
	assert.doesNotMatch(outside, /## 项目规则/)
	assert.match(outside, /当前目录未匹配到项目规则集/)
})

test('renderRules：超长文本在上限处截断并附提示', () => {
	const big = Array.from({ length: 400 }, (_, index) => ({
		title: '规则 ' + String(index),
		content: '这条规则的正文写得比较长，用来把注入文本撑到上限以上：'.repeat(4),
	}))
	const text = renderRules(sanitizeDoc({ global: big }), '/tmp/x')
	assert.ok(text.length < MAX_SECTION_CHARS + 200)
	assert.match(text, /已截断/)
	// 预览可以要求不截断
	const full = renderRules(sanitizeDoc({ global: big }), '/tmp/x', { limit: Number.POSITIVE_INFINITY })
	assert.ok(full.length > MAX_SECTION_CHARS)
	assert.doesNotMatch(full, /已截断/)
})

test('summarizeDoc：统计规模', () => {
	const summary = summarizeDoc({
		global: [{ title: 'a', content: 'a' }],
		projects: [{ path: '/tmp/a', rules: [{ title: 'b', content: 'b' }] }],
	})
	assert.deepEqual(summary, { global: 1, projects: 1, projectRules: 1, enabled: true })
})

test('分组：规范化保留 group，注入文本按组出小标题且编号连续', () => {
	const doc = sanitizeDoc({
		global: [
			{ title: 'A', content: 'a', group: '流程' },
			{ title: 'B', content: 'b' },
			{ title: 'C', content: 'c', group: '流程' },
		],
	})
	assert.equal(doc.global[0].group, '流程')
	assert.equal(doc.global[1].group, '')
	const text = renderRules(doc, '/tmp/nowhere', { limit: Number.POSITIVE_INFINITY })
	// 同一组的规则归到一起（组内保持原顺序），组标题只出现一次，编号连续
	assert.equal((text.match(/### 流程/g) || []).length, 1)
	assert.match(text, /### 流程\n1\. \*\*A\*\*/)
	assert.match(text, /2\. \*\*C\*\*/)
	assert.match(text, /3\. \*\*B\*\*/)
	assert.deepEqual(groupNames(doc), ['流程'])
})

test('覆盖模式：被挡掉的全局规则会明确告知', () => {
	const doc = sanitizeDoc({
		global: [{ title: 'G1', content: 'g1' }, { title: 'G2', content: 'g2' }],
		projects: [{ path: '/tmp/p', mode: 'override', rules: [{ title: 'P', content: 'p' }] }],
	})
	const text = renderRules(doc, '/tmp/p', { limit: Number.POSITIVE_INFINITY })
	assert.match(text, /2 条全局规则在本项目内不生效/)
	assert.match(text, /\*\*P\*\*/)
	assert.doesNotMatch(text, /\*\*G1\*\*/)
	assert.equal(effectiveRules(doc, '/tmp/p').suppressedGlobalRules.length, 2)
})

test('win32 分支：大小写不敏感、两种分隔符，且不跨目录边界', () => {
	assert.equal(normalizePath('C:/proj/sub/', undefined, 'win32'), 'C:\\proj\\sub')
	const doc = sanitizeDoc({ projects: [{ path: 'C:/proj', rules: [] }, { path: 'C:\\proj\\sub', rules: [] }] })
	assert.equal(matchProject(doc, 'c:\\proj\\sub\\deep', 'win32').path, 'C:\\proj\\sub')
	assert.equal(matchProject(doc, 'C:/PROJ', 'win32').path, 'C:\\proj')
	assert.equal(matchProject(doc, 'C:\\projabc', 'win32'), null)
	assert.equal(containsPath('C:\\proj', 'C:/proj/sub', 'win32'), true)
	// POSIX 下大小写敏感
	assert.equal(containsPath('/tmp/proj', '/tmp/PROJ/sub'), false)
})

test('estimateTokens / ruleSize：CJK 与 ASCII 的粗估', () => {
	assert.equal(estimateTokens(''), 0)
	assert.equal(estimateTokens('中文四字'), 4)
	assert.equal(estimateTokens('abcd'), 1)
	assert.ok(estimateTokens('中文 with english words') > estimateTokens('中文'))
	const size = ruleSize({ title: '标题', content: '正文正文' })
	assert.equal(size.chars, 6)
	assert.ok(size.tokens >= 6)
})

test('Markdown 导出 / 导入往返：标题、分组、正文、项目模式都保留', () => {
	const doc = sanitizeDoc({
		enabled: true,
		global: [
			{ title: '提交前跑测试', content: 'npm test 必须绿\n第二行', group: '提交' },
			{ title: '停用的规则', content: 'x', enabled: false },
		],
		projects: [
			{ path: '/tmp/proj-a', label: '示例', mode: 'override', rules: [{ title: 'A', content: 'a', group: '结构' }] },
			{ path: '/tmp/proj-b', mode: 'append', enabled: false, rules: [] },
		],
	})
	const markdown = toMarkdownDoc(doc)
	assert.match(markdown, /## 全局规则/)
	assert.match(markdown, /## 项目规则：\/tmp\/proj-a \| 示例 \[override\]/)
	const back = parseMarkdownDoc(markdown)
	assert.deepEqual(
		back.global.map((rule) => ({ t: rule.title, g: rule.group, c: rule.content, e: rule.enabled })),
		[
			{ t: '提交前跑测试', g: '提交', c: 'npm test 必须绿\n第二行', e: true },
			{ t: '停用的规则', g: '', c: 'x', e: false },
		],
	)
	assert.deepEqual(
		back.projects.map((project) => ({ p: project.path, l: project.label, m: project.mode, e: project.enabled, n: project.rules.length })),
		[
			{ p: '/tmp/proj-a', l: '示例', m: 'override', e: true, n: 1 },
			{ p: '/tmp/proj-b', l: '', m: 'append', e: false, n: 0 },
		],
	)
	// 导入后渲染出来应与原文档等价
	assert.equal(renderRules(back, '/tmp/proj-a', { limit: Number.POSITIVE_INFINITY }), renderRules(doc, '/tmp/proj-a', { limit: Number.POSITIVE_INFINITY }))
	// 认不出的内容不抛错
	assert.deepEqual(countMarkdownRules('随便一段文字\n- 一条'), { global: 1, projects: 0, projectRules: 0, enabled: true })
	assert.deepEqual(countMarkdownRules(''), { global: 0, projects: 0, projectRules: 0, enabled: true })
})
