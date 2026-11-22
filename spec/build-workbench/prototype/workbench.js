const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#${name}"/></svg>`;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pathText = (path) => esc(path).replaceAll('/', '/<wbr>');
const choices = (selector, key, value) => document.querySelectorAll(selector).forEach((button) => {
  button.setAttribute('aria-pressed', button.dataset[key] === value);
});
const projects = {
  vofa: {
    label: 'vofa_bridge', family: 'CMake', root: '~/work/vofa_bridge',
    probe: 'configure', group: 'File API', toolLabel: 'CMake · 本机可执行文件',
    toolExplanation: '检查版本和路径。configure 与 File API 目标可共用同一检查结果。',
    tools: [
      { id: 'mise', name: 'CMake 4.5.1', origin: 'mise · PATH', path: '~/.local/share/mise/installs/cmake/4.5.1/bin/cmake' },
      { id: 'brew', name: 'CMake 4.1.3', origin: 'Homebrew', path: '/opt/homebrew/opt/cmake/bin/cmake' },
    ],
    targets: [
      { id: 'example', desc: 'examples/example', group: '应用程序' },
      { id: 'player', desc: 'player/player', group: '应用程序' },
    ],
  },
  alkaa: {
    label: 'alkaa', family: 'Gradle', root: '~/work/alkaa',
    probe: 'tasks --all', group: 'Gradle Wrapper', toolLabel: 'Gradle Wrapper 9.5.1 · Java',
    toolExplanation: '本例未发现独立的 daemon JVM 配置。运行 Gradle 9.5.1 需要 JVM 17–26。',
    tools: [
      { id: 'zulu', name: 'Zulu 8', origin: 'JAVA_HOME · mise', path: '~/.local/share/mise/installs/java/zulu-8.98.0.201/bin/java', blocked: true },
      { id: 'temurin', name: 'Temurin 17.0.21.1', origin: 'mise · 建议选择', path: '~/.local/share/mise/installs/java/temurin-17.0.21.1/bin/java', recommended: true },
      { id: 'jdk21', name: 'OpenJDK 21', origin: '系统安装 · 待检查', path: '/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home/bin/java' },
    ],
    targets: [
      { id: ':app:assembleDebug', desc: '打包 Android debug APK', group: ':app' },
      { id: ':app:assembleRelease', desc: '打包 Android release APK', group: ':app' },
      { id: ':app:bundleRelease', desc: '生成 Android App Bundle', group: ':app' },
      { id: ':app:compileDebugKotlin', desc: '编译 debug Kotlin 源码', group: ':app' },
      { id: ':app:testDebugUnitTest', desc: '运行 debug 单元测试', group: ':app' },
      { id: ':desktop-app:createDistributable', desc: '生成桌面应用分发目录', group: ':desktop-app' },
      { id: ':desktop-app:packageReleaseDistributionForCurrentOS', desc: '打包当前系统的桌面发布版本', group: ':desktop-app' },
      { id: ':desktop-app:compileKotlin', desc: '编译桌面应用 Kotlin 源码', group: ':desktop-app' },
      { id: ':shared:linkDebugTestIosSimulatorArm64', desc: '链接 iOS 模拟器测试产物', group: ':shared' },
      { id: ':shared:compileKotlinMetadata', desc: '编译 Kotlin 公共元数据', group: ':shared' },
      { id: ':shared:allTests', desc: '运行公共测试', group: ':shared' },
    ],
  },
};
const states = Object.fromEntries(Object.entries(projects).map(([key, p]) => [key, {
  pane: 'editor', nav: 'targets', dock: 'output', query: '', target: p.probe,
  selected: key === 'vofa' ? 'mise' : '', verified: new Set(), runs: [], view: null,
  discovery: /** @type {{ tool: string, args: string, consumed: boolean } | null} */ (null),
  showNew: false, saved: [], drafts: new Map(),
}]));
let workspace = 'vofa';
let theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
let nextId = 1;
const project = () => projects[workspace];
const state = () => states[workspace];
const isProbe = () => state().target === project().probe;
const selectedTool = () => project().tools.find((t) => t.id === state().selected);
const busyRun = (s = state()) => s.runs.find((run) => run.status === '运行中');
function draft() {
  const s = state();
  if (!s.drafts.has(s.target)) s.drafts.set(s.target, { args: '', name: '', paths: '', inherited: false });
  return s.drafts.get(s.target);
}
function fieldError() {
  let quote = '';
  for (const ch of draft().args) {
    if (ch === quote) quote = '';
    else if (!quote && (ch === '"' || ch === "'")) quote = ch;
  }
  return quote ? '引号未闭合，请核对命令选项。' : '';
}
function command() {
  const args = draft().args.trim();
  if (workspace === 'alkaa') return `./gradlew ${state().target}${args ? ` ${args}` : ''}`;
  const cmake = selectedTool()?.path || 'cmake';
  if (isProbe()) return `${cmake} -S . -B .zeonest-build/release${args ? ` ${args}` : ''}`;
  return `${cmake} --build .zeonest-build/release --target ${state().target}${args ? ` ${args}` : ''}`;
}
function canRun() {
  const t = selectedTool();
  return !!t && !t.blocked && state().verified.has(t.id) && !busyRun() && !fieldError() && !contextError();
}
function contextError() {
  if (isProbe()) return '';
  const found = state().discovery;
  if (found?.tool !== state().selected) return '工具与上次探测不同，请用当前工具重新探测。';
  if (workspace === 'alkaa' && found?.consumed) return '此项目的探测结果只供一次构建，已使用。请重新探测。';
  if (workspace === 'alkaa' && found?.args !== draft().args.trim()) return '命令选项与上次探测不同，请用新选项重新探测。';
  return '';
}
function newTargetsReady() {
  const s = state();
  return s.showNew && isProbe() && canRun() && s.runs[0]?.status === '成功' && s.discovery?.tool === s.selected && s.discovery?.args === draft().args.trim();
}
function showNewTargets() {
  const s = state();
  s.query = '';
  s.nav = 'targets';
  pane('navigator');
  renderNav();
  $('target-list').querySelector('.nav-row .badge')?.closest('button').focus();
}
function pane(name) {
  state().pane = name;
  $('work-area').dataset.pane = name;
  choices('.compact-tabs button', 'pane', name);
}
function renderNav() {
  const s = state();
  const p = project();
  const items = s.discovery ? p.targets : [];
  $('target-count').textContent = items.length + 1;
  $('search-box').hidden = s.nav === 'saved';
  $('refresh').hidden = s.nav === 'saved';
  $('target-search').value = s.query;
  choices('[data-nav]', 'nav', s.nav);
  if (s.nav === 'saved') {
    $('target-list').innerHTML = s.saved.length ? s.saved.map((saved, index) => `<button class="nav-row" data-saved="${index}">${icon('save')}<span><strong>${esc(saved.name)}</strong><small class="mono">${esc(saved.target)}</small></span></button>`).join('') : '<p class="nav-hint">没有保存的配置。在配置区填入名称即可保存。</p>';
    return;
  }
  const groups = new Map();
  const probe = { id: p.probe, desc: workspace === 'vofa' ? '生成构建目录并读取目标' : '读取项目中的可执行任务', group: '发现目标' };
  const q = s.query.trim().toLowerCase();
  for (const t of [probe, ...items]) {
    if (q && !`${t.id} ${t.desc} ${t.group}`.toLowerCase().includes(q)) continue;
    if (!groups.has(t.group)) groups.set(t.group, []);
    groups.get(t.group).push(t);
  }
  const hint = !s.discovery ? '先执行探测，构建目标会显示在这里。' : workspace === 'alkaa' ? '本例只展示部分任务；每次探测最多保留 256 项。' : '';
  $('target-list').innerHTML = [...groups].map(([group, list]) => `<p class="group-label">${esc(group)}</p>${list.map((t) => `<button class="nav-row" data-target="${esc(t.id)}" aria-pressed="${t.id === s.target}">${icon(t === probe ? 'probe' : 'box')}<span><strong class="mono">${esc(t.id)}</strong><small>${esc(t.desc)}</small></span>${s.showNew && t !== probe ? '<span class="badge good">新</span>' : ''}</button>`).join('')}`).join('') + (groups.size ? '' : '<p class="nav-hint">没有匹配的目标。</p>') + (hint ? `<p class="nav-hint">${hint}</p>` : '');
}
function renderNotice() {
  const s = state();
  const t = selectedTool();
  const last = s.runs[0];
  let notice;
  if (busyRun()) notice = ['', '正在执行', '在底部输出区查看进度，也可以停止本次运行。'];
  else if (fieldError()) notice = ['error', '命令选项有误', fieldError()];
  else if (!t && workspace === 'alkaa') notice = ['warn', '需要选择可用的 Java', '当前 JAVA_HOME 指向 Zulu 8，低于此项目的 Gradle 运行要求。', '选择工具', 'tools'];
  else if (t?.blocked) notice = ['error', '所选 Java 不兼容', 'Zulu 8 不能运行此项目的 Gradle 9.5.1。请选择其他已安装的 Java。', '选择工具', 'tools'];
  else if (!t || !s.verified.has(t.id)) notice = ['warn', '需要检查工具链', '检查通过后即可执行当前操作。', '查看工具', 'tools'];
  else if (contextError()) notice = ['warn', '需要重新探测', contextError(), '前往探测', 'probe'];
  else if (last?.status === '失败') notice = ['error', '上次运行失败', '查看输出中的错误，修改配置后可以重试。', '查看输出', 'output'];
  else if (newTargetsReady()) notice = ['good', '探测完成，目标已刷新', workspace === 'vofa' ? '新增 example 和 player。选择其中一个才能开始构建。' : '已有可选 Gradle 任务。选择任务后再确认运行。', '再次探测', 'repeat'];
  else if (isProbe()) notice = ['', '可以执行探测', '探测用于获取目标，不会开始构建。'];
  else notice = ['good', '工具链已就绪', workspace === 'alkaa' ? '构建前会再次展示命令、工作目录和启动工具。' : '检查命令后，点击顶部「构建目标」即可开始。'];
  const [tone, title, body, label, action] = notice;
  const status = busyRun() ? '运行中' : fieldError() ? '修正选项' : t?.blocked ? '工具不兼容' : !t ? '待选工具' : !s.verified.has(t.id) ? '待检查工具' : contextError() ? '需要重新探测' : newTargetsReady() ? '目标已刷新' : '可运行';
  const mark = tone === 'good' ? 'check' : tone ? 'warn' : 'info';
  const noticeHtml = `${icon(mark)}<div class="notice-content"><strong>${title}</strong><p>${body}</p></div>${action ? `<button class="secondary" data-action="${action}">${label}</button>` : ''}`;
  const message = `${title}\n${body}`;
  if ($('notice').dataset.message !== message) {
    $('notice').innerHTML = noticeHtml;
    $('notice').dataset.message = message;
  }
  $('notice').className = `notice ${tone}`;
  $('toolbar-status').className = `tool-status ${canRun() ? 'good' : busyRun() ? '' : tone}`;
  $('toolbar-status').innerHTML = `${icon(canRun() ? 'check' : mark)}${status}`;
  $('primary').querySelector('span').textContent = newTargetsReady() ? '查看新目标' : isProbe() ? '执行探测' : workspace === 'alkaa' ? '预览并构建' : '构建目标';
  $('primary').querySelector('use').setAttribute('href', newTargetsReady() ? '#chevron' : '#play');
  $('primary').disabled = !canRun();
  $('primary').setAttribute('aria-describedby', 'toolbar-status');
}
function renderFields() {
  const d = draft();
  $('draft-label').textContent = state().saved.some((item) => item.target === state().target && ['name', 'args', 'paths'].every((k) => item[k] === d[k])) ? '已保存配置' : '临时配置';
  const error = fieldError();
  $('field-note').className = error ? 'error' : 'muted';
  $('field-note').textContent = error || (d.inherited ? '已带入本次探测的选项，可编辑。' : isProbe() ? '只应用于本次探测。' : '只应用于当前目标。');
  $('arguments').setAttribute('aria-invalid', String(!!error));
  $('arguments').setAttribute('aria-describedby', 'field-note');
  $('save').disabled = !d.name.trim() || !!error;
  $('command').textContent = command();
  renderNotice();
}
function renderEditor() {
  const s = state();
  const p = project();
  $('family').textContent = p.family;
  $('current-target').textContent = s.target;
  $('editor-title').textContent = s.target;
  $('editor-icon').innerHTML = `<use href="#${isProbe() ? 'probe' : 'box'}"/>`;
  $('source').textContent = isProbe() ? (workspace === 'vofa' ? 'CMakeLists.txt · CMake File API' : 'gradle/wrapper/gradle-wrapper.properties') : (workspace === 'vofa' ? `File API · ${p.targets.find((t) => t.id === s.target).desc}` : '本次探测结果 · Gradle Wrapper');
  $('target-type').textContent = isProbe() ? '探测' : '构建';
  $('working-dir').textContent = p.root;
  ['arguments', 'config-name', 'extra-paths'].forEach((id, i) => { $(id).value = draft()[['args', 'name', 'paths'][i]]; });
  renderFields();
}
function renderTools() {
  const s = state();
  const p = project();
  const current = selectedTool();
  $('tool-count').textContent = `${p.tools.length} 个候选`;
  $('requirement').textContent = p.toolLabel;
  $('tool-explanation').textContent = p.toolExplanation;
  $('tool-list').innerHTML = p.tools.map((t) => {
    const badge = t.blocked ? '<span class="badge error">不兼容</span>' : s.verified.has(t.id) ? '<span class="badge good">已检查</span>' : t.recommended ? '<span class="badge good">建议</span>' : '';
    return `<button data-tool="${t.id}" class="tool-row" aria-pressed="${s.selected === t.id}"><span><strong>${t.name}</strong><small>${t.origin}</small><code>${pathText(t.path)}</code></span>${badge}</button>`;
  }).join('');
  $('verify').disabled = !current || current.blocked || s.verified.has(current.id) || !!busyRun();
  $('verify-summary').className = current?.blocked ? 'error' : current && s.verified.has(current.id) ? 'good' : '';
  $('verify-summary').textContent = !current ? '未选择。建议先看候选的来源和路径。' : current.blocked ? '最低需要 JVM 17。此项目配置不会被修改。' : s.verified.has(current.id) ? (workspace === 'alkaa' ? '启动 Java 检查通过。项目兼容性由 Gradle 探测确认。' : `${current.name} 检查通过。`) : `已选择 ${current.name}，尚未检查。`;
}
function renderDock() {
  const s = state();
  choices('[data-dock]', 'dock', s.dock);
  $('stop-run').hidden = !busyRun();
  $('run-count').textContent = s.runs.length;
  const r = s.runs.find((run) => run.id === s.view);
  const tone = (run) => run?.status === '成功' ? 'good' : run?.status === '失败' ? 'error' : '';
  $('run-status').textContent = r ? `${r.kind} · ${r.status}` : '尚未运行';
  $('run-status').className = `badge ${tone(r)}`;
  if (s.dock === 'history') {
    $('dock-body').innerHTML = s.runs.length ? s.runs.map((item) => `<button class="history-row" data-run="${item.id}"><span><strong class="mono">${esc(item.target)}</strong> <small>${item.kind} · #${item.id}</small></span><span class="badge ${tone(item)}">${item.status}</span></button>`).join('') : '<span class="muted">此工作区还没有运行记录。</span>';
  } else if (s.dock === 'artifacts') {
    $('dock-body').innerHTML = r?.artifacts.length ? `<ul class="artifact-list">${r.artifacts.map((path) => `<li><code>${esc(path)}</code></li>`).join('')}</ul>` : '<span class="muted">这次运行没有产物。</span>';
  } else {
    $('dock-body').innerHTML = r ? r.lines.map(([label, line]) => `<div class="log-line"><span class="log-label">${label}</span><span class="${label === '失败' ? 'error' : label === '完成' ? 'good' : ''}">${esc(line)}</span></div>`).join('') : '<span class="muted">执行探测或构建后，输出会保留在这里。</span>';
  }
}
function render() {
  pane(state().pane);
  renderNav();
  renderEditor();
  renderTools();
  renderDock();
  $('footer-context').textContent = project().root;
}
function selectTarget(id) {
  const s = state();
  if (!s.drafts.has(id) && workspace === 'alkaa' && s.discovery && id !== project().probe && s.selected === s.discovery.tool) {
    s.drafts.set(id, { args: s.discovery.args, name: '', paths: '', inherited: !!s.discovery.args });
  }
  s.target = id;
  if (id !== project().probe) s.showNew = false;
  s.pane = 'editor';
  render();
}
function startRun() {
  if (!canRun()) return;
  const s = state();
  const key = workspace;
  const probe = isProbe();
  const selected = selectedTool();
  const r = { id: nextId++, target: s.target, kind: probe ? '探测' : '构建', status: '运行中', artifacts: [], lines: [['命令', command()], ['目录', project().root]] };
  const args = draft().args.trim();
  const paths = draft().paths.split('\n').map((path) => path.trim()).filter(Boolean);
  if (!probe && key === 'alkaa') s.discovery.consumed = true;
  s.runs.unshift(r);
  s.view = r.id;
  s.dock = 'output';
  s.pane = 'editor';
  render();
  setTimeout(() => {
    if (r.status !== '运行中') return;
    if (key === 'vofa' && probe && args.includes('--preset missing')) {
      r.status = '失败';
      r.lines.push(['stderr', 'CMake Error: No such preset: "missing"'], ['失败', '配置失败 · 退出码 1 · 本次未生成新目标']);
    } else {
      r.status = '成功';
      if (probe) {
        const fresh = !s.discovery;
        s.showNew = fresh;
        s.discovery = { tool: selected.id, args, consumed: false };
        r.lines.push(['stdout', key === 'vofa' ? 'Configuring done · Generating done' : 'BUILD SUCCESSFUL · tasks --all'], ['完成', fresh ? `目标已刷新 · 新增 ${projects[key].targets.length} 项${key === 'alkaa' ? '（演示节选）' : ''}` : '目标已刷新 · 没有新增项']);
      } else {
        if (key === 'vofa') r.artifacts = [`.zeonest-build/release/${r.target}`];
        if (r.target === ':app:assembleDebug') r.artifacts = ['app/build/outputs/apk/debug/app-debug.apk'];
        if (r.target === ':desktop-app:createDistributable') r.artifacts = ['desktop-app/build/compose/binaries/main/app/'];
        r.artifacts = [...new Set([...r.artifacts, ...paths])];
        r.lines.push(['stdout', key === 'vofa' ? `Built target ${r.target}` : 'BUILD SUCCESSFUL'], ['完成', `退出码 0 · ${r.artifacts.length} 个产物`]);
      }
    }
    if (workspace === key) {
      renderNav();
      renderFields();
      renderTools();
      renderDock();
    }
  }, 850);
}
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  const label = theme === 'dark' ? '切换亮色主题' : '切换暗色主题';
  $('theme').setAttribute('aria-label', label);
  $('theme').title = label;
  $('theme').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
}
$('theme').addEventListener('click', () => { theme = theme === 'dark' ? 'light' : 'dark'; applyTheme(); });
$('scenario').addEventListener('change', (e) => { workspace = e.target.value; render(); });
$('target-search').addEventListener('input', (e) => { state().query = e.target.value; renderNav(); });
$('refresh').addEventListener('click', () => {
  state().query = '';
  renderNav();
  $('target-search').focus();
});
$('notice').addEventListener('click', (e) => {
  const action = e.target.closest('button')?.dataset.action;
  if (action === 'tools') {
    pane('inspector');
    const list = $('tool-list');
    (list.querySelector('[data-tool="temurin"]') ?? list.querySelector('[aria-pressed="true"]') ?? list.querySelector('button'))?.focus();
  }
  if (action === 'probe') { selectTarget(project().probe); $('editor-title').focus(); }
  if (action === 'repeat') startRun();
  if (action === 'output') { state().dock = 'output'; renderDock(); document.querySelector('[data-dock="output"]').focus(); }
});
$('verify').addEventListener('click', () => {
  if ($('verify').disabled) return;
  state().verified.add(state().selected);
  renderTools();
  renderFields();
  if (canRun()) $('primary').focus();
});
$('example').addEventListener('click', () => {
  draft().args = workspace === 'alkaa' ? '--offline' : isProbe() ? '-DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH=/opt/homebrew/opt/fmt' : '--parallel 4';
  draft().inherited = false;
  renderEditor();
});
['arguments', 'config-name', 'extra-paths'].forEach((id, i) => {
  $(id).addEventListener('input', (e) => {
    draft()[['args', 'name', 'paths'][i]] = e.target.value;
    if (i === 0) draft().inherited = false;
    renderFields();
  });
});
$('save').addEventListener('click', () => {
  const s = state();
  const snapshot = { ...draft(), name: draft().name.trim(), target: s.target, tool: s.selected };
  const existing = s.saved.findIndex((item) => item.name === snapshot.name && item.target === snapshot.target);
  if (existing < 0) s.saved.push(snapshot);
  else s.saved[existing] = snapshot;
  draft().name = snapshot.name;
  s.nav = 'saved';
  render();
});
$('primary').addEventListener('click', () => {
  if (!canRun()) return;
  if (newTargetsReady()) { showNewTargets(); return; }
  if (workspace === 'alkaa' && !isProbe()) {
    $('confirm-command').textContent = command();
    $('confirm-context').textContent = `${project().root} · ${selectedTool().name}\n${selectedTool().path}`;
    $('confirm').returnValue = '';
    $('confirm').showModal();
  } else startRun();
});
$('confirm').addEventListener('close', () => { if ($('confirm').returnValue === 'build') startRun(); });
$('stop-run').addEventListener('click', () => {
  const r = busyRun();
  if (!r) return;
  r.status = '已停止';
  r.lines.push(['状态', '用户停止了本次运行。']);
  state().view = r.id;
  state().dock = 'output';
  render();
});
document.addEventListener('click', (e) => {
  const button = e.target.closest('button');
  if (!button) return;
  const { pane: nextPane, nav, target, saved, tool, dock, run } = button.dataset;
  if (nextPane) pane(nextPane);
  if (nav) { state().nav = nav; renderNav(); }
  if (target) { selectTarget(target); $('editor-title').focus(); }
  if (saved !== undefined) {
    const item = state().saved[Number(saved)];
    state().drafts.set(item.target, { ...item });
    state().selected = item.tool;
    selectTarget(item.target);
    $('editor-title').focus();
  }
  if (tool) {
    state().selected = tool;
    renderTools();
    renderFields();
    $('tool-list').querySelector(`[data-tool="${tool}"]`).focus();
  }
  if (dock) { state().dock = dock; renderDock(); }
  if (run) { state().view = Number(run); state().dock = 'output'; renderDock(); document.querySelector('[data-dock="output"]').focus(); }
});
$('editor-title').tabIndex = -1;
applyTheme();
render();
