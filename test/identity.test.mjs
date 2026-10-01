/**
 * 身份不变量：包名 / cordis patch / 客户端注册 id / 路由 / section / 变量 / 文件名 / 页签 kind
 * 必须彼此一致，且代码与配置里不能残留更名前的旧名字。
 *
 * 实现在 `scripts/check-identity.mjs`（也能单独 `npm run check:identity` 跑）——
 * 这里只是把它拉进 `node --test`，好让 CI 一起守住：这个插件曾经因为「客户端注册 id 与包名
 * 不一致」在启动时把整个界面打成「Failed to load plugins」，而宿主接口看起来一切正常。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, '..', 'scripts', 'check-identity.mjs')

test('身份自检：各处名字一致、且没有残留旧名字', () => {
	const run = spawnSync(process.execPath, [script], { encoding: 'utf8' })
	assert.equal(run.status, 0, run.stderr || run.stdout)
	assert.match(run.stdout, /身份自检通过/)
})
