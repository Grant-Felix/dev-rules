/**
 * dev-rules 浏览器半体：Web GUI 右侧栏的「开发规则」面板。
 *
 * 手写的 client bundle（不经过打包器），遵循 DSH 的
 * `window.__ModuleLoader__.load({ id, factory })` 约定：脚本执行只注册工厂，
 * 模块体（含 CSS 注入）在 factory 被 materialize 时才跑。
 *
 * 设计取向（面向「打开就知道下一步做什么」）：
 *   - 顶部吸顶：状态 + 唯一的主动作「保存并生效」，其余都收进「更多」；
 *   - 空面板给三步上手提示 + 一键插入虚构示例规则（不是作者的真实规则），不留空白无从下手；
 *   - 少用术语：说「字 / 生效 / 只用本项目规则」，不暴露 revision、id、json 字段名；
 *   - 危险动作二次确认，冲突 / 导入用横幅明确二选一；
 *   - 高级功能（导出、导入、重新载入、文件位置、使用说明）折叠在「更多」里。
 *
 * 数据全部走宿主半体挂在 /dev-rules 上的 JSON 接口（fetch）：
 *   GET  /state  POST /save  POST /reload  POST /preview
 *   GET  /workspaces  POST /export  POST /import
 *
 * 注意（本部署实测）：DSH 在启动时就把 client bundle 读进内存并按 rev 缓存，且没跑
 * `pnpm run dev:web` 时不会装 HMR watcher —— 所以**本文件改动同样需要重启一次 profile**，
 * 只硬刷新页面是拿不到新 bundle 的。
 */
window.__ModuleLoader__.load({
	id: 'dev-rules',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const { useState, useEffect, useCallback, useRef } = React;
		const h = React.createElement;

		const API = '/dev-rules';

		/** 面板内新增条目用的短 id：与宿主的 ID_PATTERN 一致。 */
		let idSeed = 0;
		function newId(prefix) {
			idSeed += 1;
			return prefix + Date.now().toString(36) + '-' + idSeed.toString(36);
		}

		const clone = (value) => JSON.parse(JSON.stringify(value));

		/** 与宿主同一套粗估公式：CJK 约 1 字 1 token，其余约 4 字符 1 token。 */
		function estimateTokens(text) {
			if (typeof text !== 'string' || text === '') return 0;
			const cjk = (text.match(/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/g) || []).length;
			let ascii = 0;
			for (const word of text.replace(/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/g, ' ').split(/\s+/)) ascii += word.length;
			return Math.round(cjk + ascii / 4);
		}

		const ruleChars = (rule) => String(rule.title || '').length + String(rule.content || '').length;
		const ruleTokens = (rule) => estimateTokens(String(rule.title || '') + ' ' + String(rule.content || ''));

		/**
		 * 搜索 / 分组筛选行是否显示：规则少时不堆控件，但**已经生效的筛选条件必须留着控件** ——
		 * 否则规则数掉到 6 条以下时筛选行整行消失、条件却还在过滤，用户既看不到被筛掉的规则，
		 * 也没有任何入口能把条件清掉（此时上移下移还会因为「筛选状态」被禁用）。
		 */
		function shouldShowFilters(totalRules, query, groupFilter) {
			return totalRules > 6 || String(query ?? '').trim() !== '' || String(groupFilter ?? '').trim() !== '';
		}

		/**
		 * Ctrl/Cmd+S 是否真的发起保存：与主动作按钮的 disabled 用同一条判定。
		 * 无改动时保存只会让宿主把「上一版」备份冲成当前版本（.bak 的意义就没了），
		 * 保存进行中再来一次则是两个并发请求写同一份文档。
		 */
		function canShortcutSave(busy, dirty) {
			return busy !== true && dirty === true;
		}

		/**
		 * 面板用的逐条上限快照，由宿主随 /state 下发（meta.limits）—— 面板不复制一份常量，
		 * 免得两边各改各的。宿主没给某项（对象为空 / 值非法）就留 undefined：
		 * maxLength 不设、标签里也不出现「上限」字样。
		 */
		function limitsOf(meta) {
			const raw = meta === null || meta === undefined ? null : meta.limits;
			if (raw === null || raw === undefined || typeof raw !== 'object') {
				return { title: undefined, group: undefined, content: undefined, rules: undefined };
			}
			const pick = (key) => (Number.isFinite(raw[key]) && raw[key] > 0 ? raw[key] : undefined);
			return { title: pick('title'), group: pick('group'), content: pick('content'), rules: pick('rules') };
		}

		/** 标题与正文都空白的规则会被宿主规范化时直接丢掉，面板不该让它静默消失。 */
		function isBlankRule(rule) {
			return String(rule.title ?? '').trim() === '' && String(rule.content ?? '').trim() === '';
		}

		/**
		 * 卡片上的体量标签。常规只报「约 N 字」；某一栏顶到上限时把上限写出来 ——
		 * 达到 maxLength 之后浏览器什么都不说，这里是不让用户「不知道为什么打不进去」的地方。
		 */
		function sizeLabel(rule, limits) {
			const touched = [];
			if (limits.title !== undefined && String(rule.title ?? '').length >= limits.title) touched.push('标题上限 ' + String(limits.title));
			if (limits.content !== undefined && String(rule.content ?? '').length >= limits.content) touched.push('正文上限 ' + String(limits.content));
			return '约 ' + String(ruleChars(rule)) + ' 字' + (touched.length === 0 ? '' : '（' + touched.join(' / ') + '）');
		}

		/**
		 * 保存前的本地校验：下面这些内容宿主会在持久化时静默处理掉，必须在面板里先拦下，
		 * 与「项目目录为空」同等对待（切到对应页签 + 说清怎么办）。
		 * 返回 null 表示可以保存，否则返回 { tab, text }。
		 */
		function validateDoc(doc, limits) {
			if (doc.projects.some((project) => String(project.path).trim() === '')) {
				return { tab: 'projects', text: '有一个项目还没填目录，补上或删掉它再保存。' };
			}
			let blank = 0;
			let blankInGlobal = 0;
			for (const rule of doc.global) {
				if (!isBlankRule(rule)) continue;
				blank += 1;
				blankInGlobal += 1;
			}
			for (const project of doc.projects) {
				for (const rule of project.rules) {
					if (isBlankRule(rule)) blank += 1;
				}
			}
			if (blank > 0) {
				return {
					tab: blankInGlobal > 0 ? 'global' : 'projects',
					text: '有 ' + String(blank) + ' 条规则的标题和正文都是空的，保存时会被丢掉；请填上或删掉它们再保存。',
				};
			}
			if (limits.rules !== undefined) {
				if (doc.global.length > limits.rules) {
					return {
						tab: 'global',
						text: '全局规则有 ' + String(doc.global.length) + ' 条，超过上限 ' + String(limits.rules) + ' 条；多余的会被丢掉，请先删减再保存。',
					};
				}
				const over = doc.projects.find((project) => project.rules.length > limits.rules);
				if (over !== undefined) {
					return {
						tab: 'projects',
						text:
							'项目「' + (over.label || over.path) + '」有 ' + String(over.rules.length) + ' 条规则，超过上限 ' + String(limits.rules) +
							' 条；多余的会被丢掉，请先删减再保存。',
					};
				}
			}
			return null;
		}

		/**
		 * 示例规则：空面板一键插入，改成自己的或直接删掉都行。
		 *
		 * **全部虚构**，不是作者的真实规则内容 —— 本项目是「代码开源 / 规则内容闭源」双轨
		 * （见本仓 NOTICE.md）：作者的规则只存在于其本机的 ~/.dsh/dev-rules.json，不进本仓。
		 */
		const SAMPLE_RULES = [
			{ title: '同一目录内风格保持一致', content: '新增代码先看邻居怎么写，别在局部引入第二套风格。', group: '惯例' },
			{ title: '依赖升级单独提交', content: '升级依赖不要和功能改动混在同一个提交里，回滚时才好切。', group: '依赖' },
			{ title: '配置项集中管理', content: '可调参数集中放一处并写清默认值，别散落在代码各处。', group: '惯例' },
			{ title: '发布前核对版本号与变更日志', content: '打 tag 之前核对版本号，并在变更日志里写下这一版改了什么。', group: '发布' },
		];

		async function callApi(path, options) {
			const response = await fetch(API + path, options);
			const text = await response.text();
			let payload = null;
			try {
				payload = text === '' ? null : JSON.parse(text);
			} catch {
				payload = null;
			}
			if (!response.ok || payload === null || payload.ok !== true) {
				const detail = payload !== null && typeof payload.error === 'string' ? payload.error : 'HTTP ' + String(response.status);
				const error = new Error(detail);
				error.status = response.status;
				error.payload = payload;
				throw error;
			}
			return payload;
		}

		const postJson = (path, body) =>
			callApi(path, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});

		const loadState = () => callApi('/state');
		/** 从磁盘重读（宿主的 POST /reload）：只给用户的显式动作使用，见 load 的说明。 */
		const reloadState = () => postJson('/reload', {});
		const saveState = (doc, revision) => postJson('/save', { doc, revision });
		const forceSave = (doc) => postJson('/save', { doc });
		const loadPreview = (doc, target) => postJson('/preview', { doc, path: target });
		const loadWorkspaces = () => callApi('/workspaces');
		const exportDoc = (doc) => postJson('/export', { doc });
		const importText = (text) => postJson('/import', { text });

		function downloadText(name, text, type) {
			try {
				const blob = new Blob([text], { type });
				const url = URL.createObjectURL(blob);
				const link = document.createElement('a');
				link.href = url;
				link.download = name;
				document.body.appendChild(link);
				link.click();
				document.body.removeChild(link);
				setTimeout(() => URL.revokeObjectURL(url), 1000);
			} catch (error) {
				console.error('[dev-rules] 导出失败', error);
			}
		}

		/** 合并导入：按 id + 标题/正文去重，冲突时保留本地已有条目。 */
		function mergeDocs(base, incoming) {
			const merged = clone(base);
			const keyOf = (rule) => String(rule.title || '') + '\u0000' + String(rule.content || '');
			const globalIds = new Set(merged.global.map((rule) => rule.id));
			const globalKeys = new Set(merged.global.map(keyOf));
			for (const rule of incoming.global) {
				const key = keyOf(rule);
				if (globalIds.has(rule.id) || globalKeys.has(key)) continue;
				merged.global.push({ ...rule, id: newId('g') });
				globalIds.add(rule.id);
				globalKeys.add(key);
			}
			for (const project of incoming.projects) {
				let target = merged.projects.find((entry) => entry.path === project.path);
				if (target === undefined) {
					target = { ...project, id: newId('p'), rules: [] };
					merged.projects.push(target);
				}
				const ids = new Set(target.rules.map((rule) => rule.id));
				const keys = new Set(target.rules.map(keyOf));
				for (const rule of project.rules) {
					const key = keyOf(rule);
					if (ids.has(rule.id) || keys.has(key)) continue;
					target.rules.push({ ...rule, id: newId('r') });
					ids.add(rule.id);
					keys.add(key);
				}
			}
			return merged;
		}

		// ---------------------------------------------------------------- UI 小件

		function IconRules(props) {
			const size = typeof props?.size === 'number' ? props.size : 16;
			return h(
				'svg',
				{
					viewBox: '0 0 16 16',
					width: size,
					height: size,
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.5,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': 'true',
				},
				h('path', { d: 'M4 2.4h5.4L12.6 5.6v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.4a1 1 0 0 1 1-1z', key: 'doc' }),
				h('path', { d: 'M9.2 2.6v3.2h3.2', key: 'fold' }),
				h('path', { d: 'M5.4 8.6h5.2', key: 'l1' }),
				h('path', { d: 'M5.4 11h3.4', key: 'l2' }),
			);
		}

		function Button(props) {
			const variants = props.variant === 'primary' ? ' dr_btnPrimary' : props.variant === 'danger' ? ' dr_btnDanger' : '';
			return h(
				'button',
				{
					type: 'button',
					className: 'dr_btn' + variants + (props.block === true ? ' dr_btnBlock' : ''),
					disabled: props.disabled === true,
					title: props.title ?? '',
					onClick: (event) => {
						event.stopPropagation();
						if (props.disabled === true) return;
						props.onClick();
					},
				},
				props.children,
			);
		}

		function IconButton(props) {
			return h(
				'button',
				{
					type: 'button',
					className: 'dr_iconBtn' + (props.danger === true ? ' dr_iconBtnDanger' : ''),
					disabled: props.disabled === true,
					title: props.title,
					'aria-label': props.title,
					onClick: (event) => {
						event.stopPropagation();
						if (props.disabled === true) return;
						props.onClick();
					},
				},
				props.children,
			);
		}

		/** 二次确认删除：第一次点变「确认删除」，3 秒后自动还原。 */
		function ConfirmButton(props) {
			const [armed, setArmed] = useState(false);
			useEffect(() => {
				if (!armed) return undefined;
				const timer = setTimeout(() => setArmed(false), 3000);
				return () => clearTimeout(timer);
			}, [armed]);
			if (!armed) {
				return h(
					IconButton,
					{ title: props.title ?? '删除（点两次确认）', danger: true, onClick: () => setArmed(true) },
					'✕',
				);
			}
			return h(
				'button',
				{
					type: 'button',
					className: 'dr_confirmBtn',
					onClick: (event) => {
						event.stopPropagation();
						setArmed(false);
						props.onConfirm();
					},
				},
				props.confirmLabel ?? '确认删除',
			);
		}

		function Check(props) {
			return h(
				'label',
				{ className: 'dr_check', title: props.title ?? '' },
				h('input', {
					type: 'checkbox',
					checked: props.checked === true,
					onChange: (event) => props.onChange(event.target.checked),
				}),
				props.children,
			);
		}

		function Message(props) {
			if (props.text === '') return null;
			return h('div', { className: 'dr_msg', 'data-kind': props.kind }, props.text);
		}

		function Hint(props) {
			return h('div', { className: 'dr_hint' }, props.children);
		}

		/**
		 * 面板错误边界：槽位条目渲染抛错会被宿主标记为 abdicated（整块面板消失），
		 * 这里兜住并把错误原文显示在面板位置，避免「点了没反应」这种无法诊断的空白。
		 */
		class PanelBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}
			static getDerivedStateFromError(error) {
				return { error };
			}
			componentDidCatch(error) {
				try {
					console.error('[dev-rules] panel render failed', error);
				} catch (ignored) {
					/* 控制台不可用时忽略 */
				}
			}
			render() {
				if (this.state.error !== null && this.state.error !== undefined) {
					const detail = String((this.state.error && this.state.error.stack) || this.state.error);
					return h(
						'div',
						{ className: 'dr_panel' },
						h('div', { className: 'dr_title' }, '开发规则面板渲染失败'),
						h(Hint, null, '把下面这段发给 DSH 即可定位；规则文件不受影响。'),
						h('pre', { className: 'dr_preview' }, detail),
						h(
							'div',
							{ className: 'dr_row' },
							h('button', { type: 'button', className: 'dr_btn', onClick: () => this.setState({ error: null }) }, '重试渲染'),
						),
					);
				}
				return this.props.children;
			}
		}

		// ------------------------------------------------------------ 规则编辑区

		function RuleRow(props) {
			const rule = props.rule;
			const limits = props.limits ?? {};
			return h(
				'div',
				{ className: 'dr_card', 'data-off': rule.enabled === false ? '1' : undefined },
				h(
					'div',
					{ className: 'dr_cardHead' },
					h('span', { className: 'dr_cardIndex' }, String(props.position)),
					h('input', {
						className: 'dr_input dr_titleInput',
						value: rule.title,
						maxLength: limits.title,
						placeholder: '一句话说明这条规则，例如：提交前跑测试',
						onChange: (event) => props.onPatch({ title: event.target.value }),
					}),
				),
				h('textarea', {
					className: 'dr_textarea',
					value: rule.content,
					maxLength: limits.content,
					rows: Math.min(12, Math.max(2, String(rule.content).split('\n').length + 1)),
					placeholder: '具体怎么做，例如：改完代码跑一次 npm test，绿灯再提交。',
					onChange: (event) => props.onPatch({ content: event.target.value }),
				}),
				h(
					'div',
					{ className: 'dr_cardFoot' },
					h('input', {
						className: 'dr_input dr_groupInput',
						list: 'dr-groups',
						value: rule.group ?? '',
						maxLength: limits.group,
						placeholder: '分组（可选）',
						title: '分组只影响展示与提示里的小标题，不影响是否生效',
						onChange: (event) => props.onPatch({ group: event.target.value }),
					}),
					h(Check, { checked: rule.enabled !== false, onChange: (value) => props.onPatch({ enabled: value }), title: '取消勾选后保留内容但不再生效' }, '生效'),
					h('span', { className: 'dr_size', title: '这条规则给每次对话增加的大致上下文量' }, sizeLabel(rule, limits)),
					h(
						'span',
						{ className: 'dr_cardTools' },
						h(IconButton, { title: props.reorderHint, disabled: props.canMove === false || props.index === 0, onClick: () => props.onMove(-1) }, '↑'),
						h(IconButton, { title: props.reorderHint, disabled: props.canMove === false || props.index >= props.total - 1, onClick: () => props.onMove(1) }, '↓'),
						h(ConfirmButton, { title: '删除这条规则（点两次确认）', onConfirm: props.onRemove }),
					),
				),
			);
		}

		function RuleList(props) {
			const rules = props.rules;
			const limits = props.limits ?? {};
			const query = String(props.query ?? '').trim().toLowerCase();
			const groupFilter = props.groupFilter ?? '';
			const filtering = query !== '' || groupFilter !== '';
			// 到上限就别再堆卡片了：宿主保存时会把多出来的丢掉，save 那里也会拦
			const atCap = limits.rules !== undefined && rules.length >= limits.rules;
			const visible = rules
				.map((rule, index) => ({ rule, index }))
				.filter(({ rule }) => {
					if (groupFilter === '__none__' && String(rule.group ?? '') !== '') return false;
					if (groupFilter !== '' && groupFilter !== '__none__' && rule.group !== groupFilter) return false;
					if (query === '') return true;
					return (
						String(rule.title ?? '').toLowerCase().includes(query) ||
						String(rule.content ?? '').toLowerCase().includes(query) ||
						String(rule.group ?? '').toLowerCase().includes(query)
					);
				});

			const patch = (index, changes) => {
				const next = clone(rules);
				next[index] = Object.assign({}, next[index], changes);
				props.onChange(next);
			};
			const move = (index, delta) => {
				const target = index + delta;
				if (target < 0 || target >= rules.length) return;
				const next = clone(rules);
				const [item] = next.splice(index, 1);
				next.splice(target, 0, item);
				props.onChange(next);
			};
			const remove = (index) => {
				const next = clone(rules);
				next.splice(index, 1);
				props.onChange(next);
			};
			const addRule = () => {
				props.onChange(
					rules.concat([
						{
							id: newId(props.idPrefix ?? 'r'),
							title: '',
							content: '',
							group: groupFilter !== '' && groupFilter !== '__none__' ? groupFilter : '',
							enabled: true,
						},
					]),
				);
			};

			return h(
				'div',
				{ className: 'dr_rules' },
				rules.length === 0
					? null
					: visible.length === 0
						? h('div', { className: 'dr_empty' }, '没有符合条件的规则。清空上面的搜索框或把分组切回「全部分组」。')
						: visible.map(({ rule, index }) =>
								h(RuleRow, {
									key: rule.id,
									rule,
									limits,
									index,
									position: index + 1,
									total: rules.length,
									canMove: !filtering,
									reorderHint: filtering ? '筛选状态下不能改顺序' : '调整顺序',
									onPatch: (changes) => patch(index, changes),
									onMove: (delta) => move(index, delta),
									onRemove: () => remove(index),
								}),
							),
				h(
					'div',
					{ className: 'dr_row' },
					h(Button, { onClick: addRule, disabled: atCap, title: atCap ? '已达每条规则集上限 ' + String(limits.rules) + ' 条' : '' }, '+ 加一条规则'),
					props.onInsertSamples !== undefined && rules.length === 0
						? h(Button, { onClick: () => props.onInsertSamples(rules) }, '插入 4 条虚构示例')
						: null,
				),
			);
		}

		// ------------------------------------------------------------- 三个页签

		function GlobalTab(props) {
			return h(
				'div',
				{ className: 'dr_section' },
				h(Hint, null, '这里放「做什么项目都适用」的规则。'),
				h(RuleList, {
					rules: props.doc.global,
					idPrefix: 'g',
					limits: props.limits,
					query: props.query,
					groupFilter: props.groupFilter,
					onChange: (rules) => props.mutate((draft) => { draft.global = rules; }),
					onInsertSamples: (rules) =>
						props.mutate((draft) => {
							for (const sample of SAMPLE_RULES) {
								if (draft.global.some((rule) => rule.title === sample.title)) continue;
								draft.global.push({ id: newId('g'), ...sample, enabled: true });
							}
						}),
				}),
			);
		}

		function ProjectsTab(props) {
			const projects = props.doc.projects;
			const patchProject = (index, changes) => {
				props.mutate((draft) => {
					draft.projects[index] = Object.assign({}, draft.projects[index], changes);
				});
			};
			const removeProject = (index) => {
				props.mutate((draft) => {
					draft.projects.splice(index, 1);
				});
			};
			return h(
				'div',
				{ className: 'dr_section' },
				h(Hint, null, '给某个项目单独加规则。会话的工作目录在那个目录下面就会用上；同时命中多个时，用范围更小的那个。'),
				projects.length === 0
					? h('div', { className: 'dr_empty' }, '还没有项目规则。一般先用「全局规则」就够了，确实需要区别对待时再加。')
					: projects.map((project, index) =>
							h(
								'div',
								{ className: 'dr_project', key: project.id },
								h(
									'div',
									{ className: 'dr_projectHead' },
									h('span', { className: 'dr_projectBadge' }, '项目 ' + String(index + 1)),
									h(Check, { checked: project.enabled !== false, onChange: (value) => patchProject(index, { enabled: value }), title: '取消勾选后这个项目的规则不生效' }, '启用'),
									h(
										'span',
										{ className: 'dr_projectTools' },
										h(ConfirmButton, {
											title: '删除这个项目的规则（点两次确认）',
											confirmLabel: '确认删除项目',
											onConfirm: () => removeProject(index),
										}),
									),
								),
								h(
									'label',
									{ className: 'dr_field' },
									h('span', { className: 'dr_fieldLabel' }, '项目目录'),
									h('input', {
										className: 'dr_input dr_pathInput',
										list: 'dr-workspaces',
										value: project.path,
										placeholder: '从下拉选一个工作区，或粘贴绝对路径',
										onChange: (event) => patchProject(index, { path: event.target.value }),
									}),
									h('span', { className: 'dr_fieldHint' }, '该目录（含子目录）下的会话会命中这套规则。'),
								),
								h(
									'div',
									{ className: 'dr_projectRow' },
									h(
										'label',
										{ className: 'dr_field' },
										h('span', { className: 'dr_fieldLabel' }, '别名（可选）'),
										h('input', {
											className: 'dr_input dr_labelInput',
											value: project.label ?? '',
											maxLength: props.limits.title,
											placeholder: '方便自己认，例如：博客',
											onChange: (event) => patchProject(index, { label: event.target.value }),
										}),
									),
									h(
										'label',
										{ className: 'dr_field' },
										h('span', { className: 'dr_fieldLabel' }, '和全局规则的关系'),
										h(
											'select',
											{
												className: 'dr_select',
												value: project.mode,
												onChange: (event) => patchProject(index, { mode: event.target.value }),
											},
											h('option', { value: 'append' }, '全局规则 + 本项目规则'),
											h('option', { value: 'override' }, '只用本项目规则'),
										),
										h('span', { className: 'dr_fieldHint' }, project.mode === 'override' ? '全局规则在这个项目里完全不生效。' : '本项目规则追加在全局规则后面。'),
									),
								),
								h(RuleList, {
									rules: project.rules,
									idPrefix: 'r',
									limits: props.limits,
									query: props.query,
									groupFilter: props.groupFilter,
									onChange: (rules) =>
										props.mutate((draft) => {
											draft.projects[index].rules = rules;
										}),
								}),
							),
						),
				h(
					'div',
					{ className: 'dr_row' },
					h(
						Button,
						{
							onClick: () =>
								props.mutate((draft) => {
									draft.projects.push({ id: newId('p'), path: '', label: '', enabled: true, mode: 'append', rules: [] });
								}),
						},
						'+ 加一个项目',
					),
				),
			);
		}

		function PreviewTab(props) {
			const [target, setTarget] = useState(props.initialPath ?? '');
			const [result, setResult] = useState(null);
			const [error, setError] = useState('');
			const [busy, setBusy] = useState(false);

			const refresh = useCallback(
				async (path) => {
					setBusy(true);
					setError('');
					try {
						setResult(await loadPreview(props.doc, path));
					} catch (cause) {
						setError(cause instanceof Error ? cause.message : String(cause));
						setResult(null);
					} finally {
						setBusy(false);
					}
				},
				[props.doc],
			);

			useEffect(() => {
				refresh(target);
			}, [refresh]);

			const biggest = result === null || !Array.isArray(result.rules) ? [] : result.rules.slice().sort((a, b) => b.tokens - a.tokens).slice(0, 5);
			return h(
				'div',
				{ className: 'dr_section' },
				h(Hint, null, '选一个目录，看看那里的会话实际会收到什么。留空则按本机当前目录算。'),
				h(
					'div',
					{ className: 'dr_row' },
					h('input', {
						className: 'dr_input dr_pathInput',
						list: 'dr-workspaces',
						value: target,
						placeholder: '项目目录，例如 /home/felix/项目/xxx',
						onChange: (event) => setTarget(event.target.value),
					}),
				),
				h(
					'div',
					{ className: 'dr_row' },
					h(Button, { onClick: () => refresh(target), disabled: busy }, busy ? '读取中…' : '查看'),
					result !== null && result.text !== ''
						? h(
								Button,
								{
									onClick: () =>
										downloadText(
											'生效规则-' + (target === '' ? '全局' : String(target).split('/').filter(Boolean).pop() || '项目') + '.md',
											result.text,
											'text/markdown;charset=utf-8',
										),
								},
								'把这段导出 md',
							)
						: null,
				),
				error !== '' ? h(Message, { kind: 'error', text: error }) : null,
				result !== null
					? h(
							'div',
							{ className: 'dr_summary' },
							resultSummary(result).map((line, index) => h('div', { className: 'dr_summaryLine', key: String(index) }, line)),
						)
					: null,
				biggest.length > 0
					? h(
							'div',
							{ className: 'dr_sizeList' },
							h('span', { className: 'dr_fieldLabel' }, '最占上下文的几条：'),
							biggest.map((rule) =>
								h('span', { className: 'dr_sizeChip', key: rule.id, title: rule.title }, (rule.title || '(无标题)') + ' · ' + String(rule.tokens) + ' token'),
							),
						)
					: null,
				h('pre', { className: 'dr_preview' }, result === null ? '' : result.text === '' ? '（这个目录下没有任何生效规则，会话不会收到额外提示）' : result.text),
			);
		}

		/** 预览结果的人话摘要（纯字符串数组，便于测试）。 */
		function resultSummary(result) {
			if (result.injected === '') return ['当前不会注入：没有生效的规则，或总开关被关掉了。'];
			const lines = [
				result.matched === null
					? '没有单独的项目规则，只用全局规则（' + String(result.counts.global) + ' 条）。'
					: '命中项目「' + (result.matched.label || result.matched.path) + '」：' +
						(result.matched.mode === 'override'
							? '只用它的 ' + String(result.counts.project) + ' 条规则，全局规则在这个目录不生效。'
							: '全局 ' + String(result.counts.global) + ' 条 + 本项目 ' + String(result.counts.project) + ' 条。'),
			];
			if (result.counts.suppressed > 0) lines.push('被这个项目挡掉的全局规则：' + String(result.counts.suppressed) + ' 条。');
			lines.push(
				'共 ' + String(result.rules.length) + ' 条规则 · 约 ' + String(result.chars) + ' 字（约 ' + String(result.tokens) + ' token）' +
					(result.truncated ? '，超过上限已截断' : ''),
			);
			return lines;
		}

		function injectedSummary(result) {
			if (result.injected === '') return '当前不注入（无生效规则或总开关关闭）';
			if (result.truncated) {
				return '实际注入 ' + String(result.injectedChars) + ' / 全文 ' + String(result.chars) + ' 字符（已截断）· 约 ' + String(result.injectedTokens) + ' token';
			}
			return '注入 ' + String(result.chars) + ' 字符 · 约 ' + String(result.tokens) + ' token';
		}

		// --------------------------------------------------------------- 面板主体

		function DevRulesPanel() {
			const [status, setStatus] = useState('loading');
			const [doc, setDoc] = useState(null);
			const [meta, setMeta] = useState(null);
			const [workspaces, setWorkspaces] = useState([]);
			const [dirty, setDirty] = useState(false);
			const [tab, setTab] = useState('global');
			const [message, setMessage] = useState({ kind: '', text: '' });
			const [busy, setBusy] = useState(false);
			const [fatal, setFatal] = useState('');
			const [conflict, setConflict] = useState(null);
			const [pendingImport, setPendingImport] = useState(null);
			const [query, setQuery] = useState('');
			const [groupFilter, setGroupFilter] = useState('');

			const revisionRef = useRef(0);
			const dirtyRef = useRef(false);
			const busyRef = useRef(false);
			const fileRef = useRef(null);
			dirtyRef.current = dirty;
			busyRef.current = busy;

			const applyState = useCallback((payload, note) => {
				setDoc(payload.doc);
				setMeta(payload.meta);
				revisionRef.current = payload.meta.revision;
				setDirty(false);
				if (note !== undefined) setMessage(note);
			}, []);

			/**
			 * 取文档。`fromDisk` 只给用户的显式动作（「放弃修改并重新载入」）用：
			 * 宿主在目录监听装不上时会退回 15 秒轮询，此时宿主内存可能比磁盘旧，而
			 * revision 没变、随后的保存不会 409 —— 等于静默覆盖别人的改动。
			 * 首次装载与后台轮询仍读内存（宿主自己会 watch 磁盘），不必多跑一趟磁盘。
			 */
			const load = useCallback(async (fromDisk) => {
				setStatus('loading');
				setFatal('');
				setConflict(null);
				try {
					const payload = fromDisk === true ? await reloadState() : await loadState();
					applyState(payload, { kind: '', text: '' });
					setStatus('ready');
				} catch (cause) {
					setFatal(cause instanceof Error ? cause.message : String(cause));
					setStatus('error');
				}
			}, [applyState]);

			useEffect(() => {
				load();
			}, [load]);

			useEffect(() => {
				let cancelled = false;
				loadWorkspaces()
					.then((payload) => {
						if (!cancelled) setWorkspaces(Array.isArray(payload.workspaces) ? payload.workspaces : []);
					})
					.catch(() => {
						/* 拿不到工作区列表不影响使用 */
					});
				return () => {
					cancelled = true;
				};
			}, []);

			// 与磁盘同步：别人（另一个会话 / 手工编辑）改了规则时，没本地改动就静默跟上，
			// 有改动就明确提示，避免下一次保存覆盖别人。
			useEffect(() => {
				if (status !== 'ready') return undefined;
				const timer = setInterval(async () => {
					if (busyRef.current) return;
					try {
						const payload = await loadState();
						if (payload.meta.revision === revisionRef.current) return;
						if (!dirtyRef.current) {
							applyState(payload, { kind: 'ok', text: '已同步外部改动（另一个会话或手工编辑）' });
						} else {
							setMessage({ kind: 'error', text: '磁盘上的规则被外部改过了，而你这边还有没保存的修改；建议先把你的改动「导出」备份，再点「放弃修改并重新载入」。' });
						}
					} catch {
						/* 宿主暂时不可用：下一轮再试 */
					}
				}, 5000);
				return () => clearInterval(timer);
			}, [status, applyState]);

			const mutate = useCallback((apply) => {
				setDoc((previous) => {
					if (previous === null) return previous;
					const draft = clone(previous);
					apply(draft);
					return draft;
				});
				setDirty(true);
				setMessage({ kind: '', text: '' });
			}, []);

			const save = useCallback(async () => {
				if (doc === null) return;
				const rejection = validateDoc(doc, limitsOf(meta));
				if (rejection !== null) {
					setTab(rejection.tab);
					setMessage({ kind: 'error', text: rejection.text });
					return;
				}
				setBusy(true);
				try {
					const payload = await saveState(doc, revisionRef.current);
					applyState(payload, { kind: 'ok', text: '已保存并生效：正在进行的对话，下一步就会带上这些规则。' });
					setConflict(null);
				} catch (cause) {
					if (cause.status === 409 && cause.payload !== null && cause.payload !== undefined) {
						setConflict({ doc: cause.payload.doc, meta: cause.payload.meta });
						setMessage({ kind: 'error', text: '保存被拦下了：磁盘上的规则被别处改过，先选一个处理方式。' });
					} else {
						setMessage({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
					}
				} finally {
					setBusy(false);
				}
			}, [doc, applyState, meta]);

			const forceSaveNow = useCallback(async () => {
				if (doc === null) return;
				setBusy(true);
				try {
					const payload = await forceSave(doc);
					applyState(payload, { kind: 'ok', text: '已用你这里的版本覆盖磁盘，并生效。' });
					setConflict(null);
				} catch (cause) {
					setMessage({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
				} finally {
					setBusy(false);
				}
			}, [doc, applyState]);

			const doExport = useCallback(
				async (kind) => {
					if (doc === null) return;
					setBusy(true);
					try {
						const payload = await exportDoc(doc);
						if (kind === 'markdown') downloadText('开发规则备份.md', payload.markdown, 'text/markdown;charset=utf-8');
						else downloadText('开发规则备份.json', payload.json, 'application/json;charset=utf-8');
						setMessage({ kind: 'ok', text: '已导出备份（包含还没保存的改动）。' });
					} catch (cause) {
						setMessage({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
					} finally {
						setBusy(false);
					}
				},
				[doc],
			);

			const pickImport = useCallback(async (event) => {
				const file = event.target.files && event.target.files[0];
				event.target.value = '';
				if (!file) return;
				setBusy(true);
				try {
					const text = await file.text();
					const payload = await importText(text);
					setPendingImport({ doc: payload.doc, summary: payload.summary, format: payload.format, name: file.name });
					setMessage({ kind: '', text: '' });
				} catch (cause) {
					setMessage({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
				} finally {
					setBusy(false);
				}
			}, []);

			useEffect(() => {
				const onKeyDown = (event) => {
					if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
					event.preventDefault();
					// 用 ref 读最新值：这个 effect 只随 save 重建，不能靠闭包里的 busy / dirty
					if (!canShortcutSave(busyRef.current, dirtyRef.current)) return;
					save();
				};
				window.addEventListener('keydown', onKeyDown);
				return () => window.removeEventListener('keydown', onKeyDown);
			}, [save]);

			const groups = [];
			const seenGroups = new Set();
			const collectGroups = (rules) => {
				for (const rule of rules) {
					const name = String(rule.group ?? '');
					if (name !== '' && !seenGroups.has(name)) {
						seenGroups.add(name);
						groups.push(name);
					}
				}
			};
			if (doc !== null) {
				collectGroups(doc.global);
				for (const project of doc.projects) collectGroups(project.rules);
			}
			const totalRules = doc === null ? 0 : doc.global.length + doc.projects.reduce((sum, project) => sum + project.rules.length, 0);
			/** 上限由宿主下发（meta.limits），保存校验与输入框的 maxLength 共用这一份。 */
			const limits = limitsOf(meta);

			if (status === 'loading') {
				return h('div', { className: 'dr_panel' }, h('div', { className: 'dr_empty' }, '读取规则中…'));
			}
			if (status === 'error' || doc === null) {
				return h(
					'div',
					{ className: 'dr_panel' },
					h(Message, { kind: 'error', text: '读取失败：' + fatal }),
					h('div', { className: 'dr_row' }, h(Button, { onClick: load }, '重试')),
				);
			}

			return h(
				'div',
				{ className: 'dr_panel' },
				h(
					'div',
					{ className: 'dr_top' },
					h(
						'div',
						{ className: 'dr_topRow' },
						h('span', { className: 'dr_titleIcon' }, h(IconRules, { size: 15 })),
						h('span', { className: 'dr_title' }, '开发规则'),
						h(
							'button',
							{
								type: 'button',
								className: 'dr_statusChip',
								'data-on': doc.enabled !== false ? '1' : undefined,
								title: doc.enabled !== false ? '点一下可以整体停用（规则保留，但所有会话都不再收到）' : '点一下重新启用',
								onClick: () => mutate((draft) => { draft.enabled = !(draft.enabled !== false); }),
							},
							doc.enabled !== false ? '生效中' : '已停用',
						),
						h(Button, { onClick: () => doExport('markdown'), disabled: busy }, '导出 md'),
						h(Button, { variant: 'primary', onClick: save, disabled: busy || !dirty }, busy ? '保存中…' : dirty ? '保存并生效' : '已保存'),
					),
					h(
						'div',
						{ className: 'dr_topSub' },
						'这里写的规则会自动出现在对应会话的提示里，让 agent 按你的习惯干活。共 ' + String(totalRules) + ' 条。',
					),
				),
				h(Message, { kind: message.kind, text: message.text }),
				conflict !== null
					? h(
							'div',
							{ className: 'dr_banner' },
							h('div', null, '别处已经改过磁盘上的规则，直接保存会把那些改动覆盖掉。选一个：'),
							h(
								'span',
								{ className: 'dr_bannerActions' },
								h(
									Button,
									{
										disabled: busy,
										onClick: () => {
											applyState({ doc: conflict.doc, meta: conflict.meta }, { kind: 'ok', text: '已载入磁盘上的版本，你之前的本地修改已丢弃。' });
											setConflict(null);
										},
									},
									'载入磁盘版本（放弃我的修改）',
								),
								h(Button, { variant: 'danger', onClick: forceSaveNow, disabled: busy }, '用我的修改覆盖'),
							),
						)
					: null,
				pendingImport !== null
					? h(
							'div',
							{ className: 'dr_banner' },
							h('div', null, '读到了 ' + pendingImport.name + '：全局 ' + String(pendingImport.summary.global) + ' 条 · 项目 ' + String(pendingImport.summary.projects) + ' 个（共 ' + String(pendingImport.summary.projectRules) + ' 条项目规则）。要怎么用？'),
							h(
								'span',
								{ className: 'dr_bannerActions' },
								h(
									Button,
									{
										onClick: () => {
											setDoc(pendingImport.doc);
											setDirty(true);
											setPendingImport(null);
											setMessage({ kind: 'ok', text: '已替换成导入的内容，确认没问题后点「保存并生效」。' });
										},
									},
									'替换现有规则',
								),
								h(
									Button,
									{
										onClick: () => {
											const incoming = pendingImport.doc;
											mutate((draft) => {
												const merged = mergeDocs(draft, incoming);
												draft.global = merged.global;
												draft.projects = merged.projects;
											});
											setPendingImport(null);
											setMessage({ kind: 'ok', text: '已合并（重复的不会重复加），确认后点「保存并生效」。' });
										},
									},
									'合并进来',
								),
								h(Button, { onClick: () => setPendingImport(null) }, '算了'),
							),
						)
					: null,
				totalRules === 0
					? h(
							'div',
							{ className: 'dr_onboarding' },
							h('div', { className: 'dr_onboardingTitle' }, '还没有规则，两步就能用起来'),
							h(
								'ol',
								{ className: 'dr_onboardingList' },
								h('li', null, '在下面写 1~3 条「做什么项目都适用」的规则（比如：改完代码跑测试）。'),
								h('li', null, '以后需要区别对待时，再到「项目规则」给某个目录单独加。'),
							),
							h(
								'div',
								{ className: 'dr_row' },
								h(
									Button,
									{
										variant: 'primary',
										onClick: () =>
											mutate((draft) => {
												for (const sample of SAMPLE_RULES) {
													if (draft.global.some((rule) => rule.title === sample.title)) continue;
													draft.global.push({ id: newId('g'), ...sample, enabled: true });
												}
											}),
									},
									'先插入 4 条虚构示例',
								),
								h('span', { className: 'dr_hintInline' }, '插进来就能改，改完点右上角「保存并生效」。'),
							),
						)
					: null,
				h(
					'div',
					{ className: 'dr_tabs' },
					[
						['global', '全局规则 ' + String(doc.global.length)],
						['projects', '项目规则 ' + String(doc.projects.length)],
						['preview', '效果预览'],
					].map(([key, label]) =>
						h(
							'button',
							{
								key,
								type: 'button',
								className: 'dr_tab',
								'data-on': tab === key ? '1' : undefined,
								onClick: () => setTab(key),
							},
							label,
						),
					),
				),
				shouldShowFilters(totalRules, query, groupFilter)
					? h(
							'div',
							{ className: 'dr_row dr_filterRow' },
							h('input', {
								className: 'dr_input dr_search',
								value: query,
								placeholder: '搜索规则…',
								onChange: (event) => setQuery(event.target.value),
							}),
							h(
								'select',
								{ className: 'dr_select', value: groupFilter, onChange: (event) => setGroupFilter(event.target.value) },
								h('option', { value: '' }, '全部分组'),
								h('option', { value: '__none__' }, '未分组'),
								groups.map((name) => h('option', { key: name, value: name }, name)),
							),
						)
					: null,
				h(
					'div',
					{ className: 'dr_body' },
					tab === 'global'
						? h(GlobalTab, { doc, mutate, limits, query, groupFilter })
						: tab === 'projects'
							? h(ProjectsTab, { doc, mutate, limits, query, groupFilter })
							: h(PreviewTab, { doc, initialPath: '' }),
				),
				h(
					'details',
					{ className: 'dr_more' },
					h('summary', null, '更多（备份、导入、文件位置、使用说明）'),
					h(
						'div',
						{ className: 'dr_moreBody' },
						h(
							'div',
							{ className: 'dr_moreGroup' },
							h('div', { className: 'dr_fieldLabel' }, '备份与迁移'),
							h(
								'div',
								{ className: 'dr_row' },
								h(Button, { onClick: () => doExport('markdown'), disabled: busy }, '导出备份（Markdown）'),
								h(Button, { onClick: () => doExport('json'), disabled: busy }, '导出备份（JSON）'),
								h(Button, { onClick: () => fileRef.current !== null && fileRef.current.click(), disabled: busy }, '从备份导入…'),
							),
							h(Hint, null, 'Markdown 备份可以直接改（`1. **标题**` 下面缩进的行算正文），也能导入回来。'),
						),
						h(
							'div',
							{ className: 'dr_moreGroup' },
							h('div', { className: 'dr_fieldLabel' }, '维护'),
							h(
								'div',
								{ className: 'dr_row' },
								h(
									Button,
									{
										onClick: () => {
											if (dirty && !window.confirm('还有没保存的修改，重新载入会丢掉它们。继续？')) return;
											load(true);
										},
									},
									'放弃修改并重新载入',
								),
							),
						),
						h(
							'div',
							{ className: 'dr_moreGroup' },
							h('div', { className: 'dr_fieldLabel' }, '使用说明'),
							h(
								'ul',
								{ className: 'dr_help' },
								h('li', null, '「全局规则」对每个会话生效；「项目规则」只在工作目录落在该项目目录下时生效。'),
								h('li', null, '项目的两种用法：「全局规则 + 本项目规则」追加，或「只用本项目规则」把全局规则在这个项目里完全关掉。'),
								h('li', null, '规则里的「约 N 字」是它给每轮对话增加的上下文量，规则越多、越长，模型每步要读的就越多。'),
								h('li', null, '保存后立即生效：正在进行的对话从下一步开始带上，不用重启。'),
								h('li', null, '不想让某条规则生效时，取消它的「生效」勾选即可，内容不会丢。'),
							),
						),
						h(
							'div',
							{ className: 'dr_moreGroup' },
							h('div', { className: 'dr_fieldLabel' }, '文件位置'),
							h('div', { className: 'dr_filePath' }, meta === null ? 'dev-rules.json' : meta.file),
							meta !== null && meta.backupFile !== undefined ? h('div', { className: 'dr_filePath' }, '上一版备份：' + meta.backupFile) : null,
							meta !== null && meta.error !== '' ? h('div', { className: 'dr_footError' }, '文件告警：' + meta.error) : null,
						),
					),
				),
				h('input', {
					ref: fileRef,
					type: 'file',
					accept: '.json,.md,.markdown,.txt,application/json,text/markdown,text/plain',
					className: 'dr_fileInput',
					onChange: pickImport,
				}),
				h(
					'div',
					{ className: 'dr_bottomBar' },
					h(Button, { variant: 'primary', onClick: save, disabled: busy || !dirty }, busy ? '保存中…' : dirty ? '保存并生效' : '没有未保存的修改'),
					h('span', { className: 'dr_hintInline' }, dirty ? '保存后正在进行的对话下一步就会带上这些规则。' : '改点什么，这里就能保存。'),
				),
				h(
					'datalist',
					{ id: 'dr-groups' },
					groups.map((name) => h('option', { key: name, value: name })),
				),
				h(
					'datalist',
					{ id: 'dr-workspaces' },
					workspaces.map((entry) => h('option', { key: entry.path, value: entry.path }, entry.title)),
				),
			);
		}

		// ------------------------------------------------------------------ 样式

		const CSS = `
.dr_panel { height: 100%; overflow: auto; padding: 12px 14px 28px; font-family: inherit; background: var(--dsw-alias-bg-base, transparent); color: var(--dsw-alias-label-primary, #1b1c1e); font-size: 13px; line-height: 1.6; }
.dr_panel * { box-sizing: border-box; }
.dr_top { padding: 4px 0 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); }
.dr_topRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dr_topSub { margin-top: 4px; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dr_titleIcon { display: inline-flex; color: var(--dsw-alias-label-secondary, #6b7280); }
.dr_title { font-size: 15px; font-weight: 600; }
.dr_statusChip { font: inherit; font-size: 11.5px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.25)); background: transparent; color: inherit; border-radius: 999px; padding: 1px 9px; cursor: pointer; }
.dr_statusChip[data-on] { border-color: var(--dsw-alias-state-success-primary, #2f9e6e); }
.dr_statusChip[data-on]::before { content: ''; display: inline-block; width: 6px; height: 6px; margin-right: 5px; border-radius: 50%; background: var(--dsw-alias-state-success-primary, #2f9e6e); vertical-align: middle; }
.dr_topRow .dr_btnPrimary { margin-left: auto; }
.dr_btn { font: inherit; font-size: 12px; line-height: 1.5; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.25)); background: transparent; color: inherit; border-radius: 7px; padding: 5px 12px; cursor: pointer; }
.dr_btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dr_btn:disabled { opacity: .45; cursor: not-allowed; }
/* 主动作不填色：只加品牌色描边 + 加粗，文字始终用面板文字色，任何主题下都看得见 */
.dr_btnPrimary { border-color: var(--dsw-alias-brand-primary, #4d6bfe); border-width: 1.5px; font-weight: 600; }
.dr_btnPrimary:disabled { border-color: var(--dsw-alias-border-l2, rgba(0,0,0,.25)); }
.dr_btnDanger { border-color: var(--dsw-alias-state-error-primary, #e5534b); color: var(--dsw-alias-state-error-primary, #e5534b); }
.dr_iconBtn { font: inherit; font-size: 12px; border: 1px solid transparent; background: transparent; color: inherit; border-radius: 6px; width: 24px; height: 24px; line-height: 1; cursor: pointer; opacity: .75; }
.dr_iconBtn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.05)); color: var(--dsw-alias-label-primary, #1b1c1e); }
.dr_iconBtn:disabled { opacity: .3; cursor: not-allowed; }
.dr_iconBtnDanger:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary, #e5534b); }
.dr_confirmBtn { font: inherit; font-size: 11.5px; border: 1px solid var(--dsw-alias-state-error-primary, #e5534b); background: transparent; color: inherit; border-radius: 6px; padding: 3px 8px; cursor: pointer; white-space: nowrap; font-weight: 600; }
.dr_onboarding { margin: 0 0 12px; padding: 12px 14px; border-radius: 10px; border: 1px dashed var(--dsw-alias-border-l2, rgba(0,0,0,.2)); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.02)); display: flex; flex-direction: column; gap: 8px; }
.dr_onboardingTitle { font-size: 13px; font-weight: 600; }
.dr_onboardingList { margin: 0; padding-left: 20px; font-size: 12.5px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dr_hintInline { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dr_tabs { display: flex; gap: 4px; margin: 0 0 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1)); flex-wrap: wrap; }
.dr_tab { font: inherit; font-size: 12.5px; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #6b7280); padding: 7px 9px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.dr_tab[data-on] { color: var(--dsw-alias-brand-primary, #4d6bfe); border-bottom-color: var(--dsw-alias-brand-primary, #4d6bfe); font-weight: 600; }
.dr_section { display: flex; flex-direction: column; gap: 10px; }
.dr_hint { font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dr_rules { display: flex; flex-direction: column; gap: 10px; }
.dr_card { border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1)); border-radius: 10px; padding: 10px 12px; background: var(--dsw-alias-bg-layer-1, transparent); display: flex; flex-direction: column; gap: 8px; }
.dr_card[data-off] { opacity: .55; }
.dr_cardHead { display: flex; align-items: center; gap: 8px; }
.dr_cardIndex { font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); min-width: 14px; text-align: right; }
.dr_cardFoot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dr_cardTools { margin-left: auto; display: flex; gap: 2px; align-items: center; }
.dr_size { font-size: 11px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dr_input, .dr_textarea, .dr_select { border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16)); border-radius: 7px; background: var(--dsw-alias-bg-base, transparent); color: inherit; padding: 5px 9px; font-size: 12.5px; font-family: inherit; }
.dr_input:focus, .dr_textarea:focus, .dr_select:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dr_titleInput { flex: 1 1 auto; min-width: 120px; font-weight: 600; }
.dr_groupInput { flex: 0 1 120px; min-width: 90px; font-size: 11.5px; }
.dr_textarea { width: 100%; resize: vertical; line-height: 1.6; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dr_pathInput { flex: 1 1 200px; min-width: 140px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dr_labelInput { flex: 1 1 120px; }
.dr_select { flex: 0 0 auto; max-width: 100%; }
.dr_row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dr_filterRow { margin-bottom: 10px; }
.dr_check { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); cursor: pointer; white-space: nowrap; }
.dr_check input { accent-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dr_field { display: flex; flex-direction: column; gap: 4px; flex: 1 1 200px; }
.dr_fieldLabel { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dr_fieldHint { font-size: 11px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dr_project { border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 10px; background: var(--dsw-alias-bg-layer-1, transparent); }
.dr_projectHead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dr_projectBadge { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.06)); color: var(--dsw-alias-label-secondary, #6b7280); }
.dr_projectTools { margin-left: auto; }
.dr_projectRow { display: flex; gap: 10px; flex-wrap: wrap; }
.dr_empty { border: 1px dashed var(--dsw-alias-border-l2, rgba(0,0,0,.16)); border-radius: 10px; padding: 14px; font-size: 12.5px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dr_msg { margin: 0 0 10px; font-size: 12.5px; }
.dr_msg[data-kind="ok"] { color: var(--dsw-alias-state-success-primary, #2f9e6e); }
.dr_msg[data-kind="error"] { color: var(--dsw-alias-state-error-primary, #e5534b); }
.dr_banner { margin: 0 0 12px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-state-warn-primary, #d29922); font-size: 12px; display: flex; flex-direction: column; gap: 8px; }
.dr_bannerActions { display: flex; gap: 8px; flex-wrap: wrap; }
.dr_summary { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dr_summaryLine { }
.dr_preview { margin: 0; padding: 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1)); background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.03)); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; max-height: 55vh; overflow: auto; }
.dr_sizeList { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11.5px; }
.dr_sizeChip { padding: 1px 7px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.05)); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dr_more { margin-top: 18px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); padding-top: 10px; }
.dr_more summary { cursor: pointer; font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dr_moreBody { display: flex; flex-direction: column; gap: 14px; margin-top: 10px; }
.dr_moreGroup { display: flex; flex-direction: column; gap: 6px; }
.dr_help { margin: 0; padding-left: 18px; font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); display: flex; flex-direction: column; gap: 4px; }
.dr_filePath { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #6b7280); word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dr_footError { font-size: 11.5px; color: var(--dsw-alias-state-error-primary, #e5534b); }
.dr_fileInput { display: none; }
.dr_bottomBar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); }
`;

		// ------------------------------------------------------------ 插件注册

		const inject = ['slots'];

		/** 右侧栏里的实现 id 与 tab 类型（与 Docker 容器面板同一套宿主契约）。 */
		const TAB_IMPL_ID = 'dev-rules:panel';
		const TAB_KIND = 'dev-rules';

		function apply(ctx) {
			const slots = ctx.get('slots');
			if (slots === undefined) return;

			ctx.effect(() => {
				const style = document.createElement('style');
				style.setAttribute('data-plugin', 'dev-rules');
				style.textContent = CSS;
				document.head.appendChild(style);
				return () => {
					if (style.parentNode) style.parentNode.removeChild(style);
				};
			}, 'dev-rules: 样式');

			// 右侧栏标签：像「Docker 容器」那样，在右侧栏的页面列表里出现一行「开发规则」，
			// 点开后在右列打开面板本身（tab 体注册进 sidebar.right.pane.tab）。
			// 服务可能比本插件晚出现，所以走 ctx.inject 等它，而不是硬依赖。
			ctx.inject(['sidebarRightTabs'], (injected) => {
				const tabs = injected.get('sidebarRightTabs');
				if (tabs === undefined) return;
				const disposeType = tabs.register({
					id: TAB_IMPL_ID,
					kind: TAB_KIND,
					priority: 'extension',
					title: () => '开发规则',
					guide: [
						{
							order: 95,
							title: () => '开发规则',
							description: () => '让 agent 按你的习惯干活：全局 + 按项目',
						},
					],
				});
				const disposeBody = slots.inject('sidebar.right.pane.tab', () =>
					slots.register(
						{ name: 'sidebar.right.pane.tab', key: TAB_IMPL_ID },
						() => h(PanelBoundary, null, h(DevRulesPanel)),
					),
				);
				return () => {
					disposeBody();
					disposeType();
				};
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		// 纯函数内部件：只给测试用（与 dsh-docker 的 __pick/__overview 同类做法）。
		exports.__internal = {
			estimateTokens,
			mergeDocs,
			injectedSummary,
			resultSummary,
			shouldShowFilters,
			canShortcutSave,
			limitsOf,
			sizeLabel,
			validateDoc,
		};
		return module.exports;
	},
});
