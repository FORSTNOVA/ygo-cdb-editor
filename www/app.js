(function () {
  'use strict';

  const state = {
    items: [], offset: 0, limit: 60, total: 0,
    exhausted: false, loading: false, dbReady: false, mode: 'db'
  };

  let selectedId = null;
  let editing = false;
  let filter = { q: '', kind: '', sub: '' };

  const $ = sel => document.querySelector(sel);
  const grid = $('#grid');
  const sheet = $('#sheet');
  const sheetMask = $('#sheetMask');
  const statusEl = $('#status');
  const tabbar = $('#tabbar');
  const plusMenu = $('#plusMenu');
  const plusMask = $('#plusMask');

  const fmt = n => (n === null || n === undefined ? '?' : n);
  // 数值输入框用：空值留空（塞 '?' 会触发 number input 解析警告且显示为空）
  const numOrEmpty = n => (n === null || n === undefined || isNaN(n) ? '' : n);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // 系列码 -> 中文系列名（来自 setnames.js 的 window.YGO_SETNAMES）
  function setcodeName(code) {
    code = parseInt(code, 10);
    if (isNaN(code) || !code) return '';
    return (window.YGO_SETNAMES && window.YGO_SETNAMES[code]) || '';
  }
  const setcodeHex = code => '0x' + Number(code).toString(16).toUpperCase();
  function setcodeLabel(chunks) {
    const arr = (chunks || []).filter(x => x);
    if (!arr.length) return '';
    return arr.map(c => {
      const nm = setcodeName(c);
      return nm ? `${c}（${setcodeHex(c)}，${nm}）` : `${c}（${setcodeHex(c)}）`;
    }).join(' / ');
  }

  // 别名（alias）解析：YGOPro 规则下，带别名的卡在游戏内显示目标卡的名
  function aliasEntry(c) {
    if (!c.alias) return null;
    const t = state.dbReady ? DBClient.get(c.alias) : null;
    return { id: c.alias, name: t && t.name ? t.name : null };
  }

  // ---------- 文档页签（内置库 / 打开的文件 / 新建文件） ----------
  const KIND_LABEL = { builtin: '内置', file: '文件', new: '新建' };

  function resetFilters() {
    filter.q = ''; filter.kind = '';
    const si = $('#searchInput'); if (si) si.value = '';
    const fk = $('#filterKind'); if (fk) fk.value = '';
  }

  function renderTabs() {
    if (!tabbar) return;
    const docs = DBClient.docs();
    if (!docs.length) { tabbar.style.display = 'none'; tabbar.innerHTML = ''; return; }
    tabbar.style.display = '';
    tabbar.innerHTML = docs.map(d =>
      `<div class="tab kind-${d.kind} ${d.id === DBClient.activeId ? 'active' : ''}" data-id="${d.id}" title="${esc(d.name)}（${KIND_LABEL[d.kind]}）">` +
        `<span class="tab-kind">${KIND_LABEL[d.kind]}</span>` +
        `<span class="tab-name">${esc(d.name)}${d.dirty ? ' *' : ''}</span>` +
        `<button class="tab-close" data-close="${d.id}">×</button>` +
      `</div>`).join('') +
      `<button class="tab-add" id="tabAdd">＋</button>`;
    tabbar.querySelectorAll('.tab').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('[data-close]')) return;
        switchDoc(Number(el.dataset.id));
      });
    });
    tabbar.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); closeDoc(Number(btn.dataset.close)); });
    });
    const add = $('#tabAdd');
    if (add) add.onclick = showPlusMenu;
  }

  function switchDoc(id) {
    if (id === DBClient.activeId) return;
    DBClient.setActive(id);
    resetFilters(); closeSheet(); renderTabs();
    loadPage(true);
  }

  function closeDoc(id) {
    const d = DBClient.docs().find(x => x.id === id);
    if (d && d.dirty && !confirm('「' + d.name + '」有未保存的修改，确定关闭？')) return;
    const next = DBClient.closeDoc(id);
    resetFilters(); closeSheet(); renderTabs();
    if (next) { state.dbReady = true; state.mode = 'db'; }
    else { state.dbReady = false; state.mode = 'sample'; }
    loadPage(true);
  }

  function showPlusMenu() {
    plusMenu.classList.toggle('show');
    plusMask.classList.toggle('show', plusMenu.classList.contains('show'));
  }
  function hidePlusMenu() {
    plusMenu.classList.remove('show');
    plusMask.classList.remove('show');
  }

  // 同名文档自动加序号：new.cards.cdb → new.cards(2).cdb
  function uniqueDocName(base) {
    const docs = DBClient.docs();
    if (!docs.some(d => d.name === base)) return base;
    const m = base.match(/^(.*?)(\.cdb)$/i);
    const stem = m ? m[1] : base, ext = m ? m[2] : '';
    for (let i = 2; ; i++) {
      const nm = stem + '(' + i + ')' + ext;
      if (!docs.some(d => d.name === nm)) return nm;
    }
  }

  // 示例数据过滤（与 DBClient.list 的 kind/sub 语义一致）
  function matchSample(c) {
    const d = YGO.decodeType(c.type);
    if (filter.kind && d.kind !== filter.kind) return false;
    if (filter.sub) {
      if (filter.sub === 'normal') {
        if (filter.kind === 'monster') { if (!d.normal) return false; }
        else if (filter.kind === 'spell') { if (d.quickplay || d.continuous || d.equip || d.field || d.ritual) return false; }
        else if (filter.kind === 'trap') { if (d.counter || d.continuous) return false; }
      } else if (!d[filter.sub]) return false;
    }
    return true;
  }

  // ---------- 数据层（客户端 sql.js / 内置示例回退） ----------
  async function loadPage(reset) {
    if (reset) { state.offset = 0; state.items = []; state.exhausted = false; }
    if (state.loading || state.exhausted) return;
    state.loading = true; renderStatus();
    try {
      if (state.dbReady) {
        const data = await DBClient.list({ q: filter.q, kind: filter.kind, sub: filter.sub, offset: state.offset, limit: state.limit });
        state.total = data.total;
        state.items = reset ? data.items : state.items.concat(data.items);
        state.offset += data.items.length;
        if (data.items.length < state.limit) state.exhausted = true;
      } else {
        state.mode = 'sample';
        let list = (window.SAMPLE_CARDS || []).map(c => ({ ...c }));
        const q = filter.q.trim().toLowerCase();
        if (q) list = list.filter(c => (c.name || '').toLowerCase().includes(q) || (c.desc || '').toLowerCase().includes(q));
        list = list.filter(matchSample);
        state.items = list; state.total = list.length; state.exhausted = true;
      }
    } catch (e) {
      state.mode = 'sample'; state.exhausted = true;
      let list = (window.SAMPLE_CARDS || []).map(c => ({ ...c }));
      const q = filter.q.trim().toLowerCase();
      if (q) list = list.filter(c => (c.name || '').toLowerCase().includes(q) || (c.desc || '').toLowerCase().includes(q));
      list = list.filter(matchSample);
      state.items = list; state.total = list.length;
    } finally {
      state.loading = false; renderGrid(); renderStatus();
    }
  }

  function renderStatus() {
    if (!statusEl) return;
    if (state.mode === 'sample') statusEl.textContent = '示例数据（未加载 CDB）';
    else statusEl.textContent = `共 ${state.total} 张 · ${DBClient.sourceName}` + (state.loading ? ' · 加载中…' : '');
    // 当前不是内置库时，提供一键恢复
    const rb = $('#btnResetDb');
    if (rb) rb.style.display = (state.mode === 'db' && DBClient.sourceName !== 'cards.cdb') ? '' : 'none';
  }

  // ---------- 卡列表 ----------
  function linkGrid(markers) {
    const map = { top_left: '↖', top: '↑', top_right: '↗', left: '←', right: '→', bottom_left: '↙', bottom: '↓', bottom_right: '↘' };
    const order = ['top_left', 'top', 'top_right', 'left', 'center', 'right', 'bottom_left', 'bottom', 'bottom_right'];
    const set = new Set(markers || []);
    return '<div class="link-grid">' + order.map(k => {
      if (k === 'center') return '<span></span>';
      return `<span class="${set.has(k) ? 'on' : ''}">${map[k]}</span>`;
    }).join('') + '</div>';
  }

  function stars(n) { return '★'.repeat(n || 0); }

  function cardHTML(c) {
    const d = YGO.decodeType(c.type);
    const fr = YGO.frameClass(c);
    const at = YGO.attrEntry(c.attribute || 0);
    const sl = (c.scaleL != null) ? c.scaleL : c.lscale;
    const sr = (c.scaleR != null) ? c.scaleR : c.rscale;
    let meta = '';
    if (d.kind === 'monster') {
      if (d.link) meta = `<div class="card-meta"><span class="card-link-label">LINK-${c.level}</span></div>`;
      else if (d.xyz) meta = `<div class="card-meta"><span class="card-rank-pill">${stars(c.level)}</span></div>`;
      else meta = `<div class="card-meta"><span class="card-stars">${stars(c.level)}</span></div>`;
    }
    let pend = '';
    if (d.pendulum) {
      pend = `<div class="card-pend">
        <span class="pend-scale pend-l">${fmt(sl)}</span>
        <div class="pend-text">${esc(c.pendulumDesc || '')}</div>
        <span class="pend-scale pend-r">${fmt(sr)}</span>
      </div>`;
    }
    const linkHTML = d.link ? linkGrid(c.linkMarkers) : '';
    let stats;
    if (d.kind === 'monster') stats = d.link ? `ATK/${fmt(c.atk)} LINK-${c.level}` : `ATK/${fmt(c.atk)} DEF/${fmt(c.def)}`;
    else stats = YGO.typeLabel(c);
    const headScale = d.pendulum
      ? `<span class="pend-scale pend-l head">${fmt(sl)}</span><span class="pend-scale pend-r head">${fmt(sr)}</span>`
      : '';
    const attrDiv = d.kind === 'monster'
      ? `<div class="card-attr attr-bit" title="${at.en}" style="${attrStyle(c.attribute)}">${at.name}</div>`
      : `<div class="card-attr spell-tag">${d.kind === 'spell' ? '魔' : '陷'}</div>`;
    return `<div class="card ${fr}" data-id="${c.id}">
      <div class="card-inner">
        <div class="card-head">
          ${headScale}
          <div class="card-name">${esc(c.name)}</div>
          ${attrDiv}
        </div>
        ${meta}
        <div class="card-art"><span class="ph">插画</span>${linkHTML}</div>
        ${pend}
        <div class="card-desc">${esc(c.desc)}</div>
        <div class="card-foot">
          <span class="card-type-line">${YGO.typeLabel(c)}</span>
          <span class="card-stats">${stats}</span>
          <span class="card-pass">No.${String(c.id).padStart(8, '0')}</span>
        </div>
      </div>
    </div>`;
  }

  function attrStyle(v) {
    const m = { 0x1: '#8d6e4b', 0x2: '#2a7fd4', 0x4: '#d9483b', 0x8: '#3a9d4f', 0x10: '#e6b422', 0x20: '#6a3aa0', 0x40: '#19b3c4' };
    let bg = '#888', fg = '#fff';
    for (const k in m) if ((v >>> 0) & k) { bg = m[k]; fg = (k == 0x10) ? '#3a2c00' : '#fff'; }
    return `background:${bg};color:${fg}`;
  }

  function renderGrid() {
    if (!state.items.length) {
      let msg = '没有匹配的卡片';
      // 区分「空数据库」和「搜索/筛选无结果」，避免被误认为打开失败
      if (state.mode === 'db' && !filter.q && !filter.kind && state.total === 0) {
        msg = '当前数据库为空（0 张卡）——点底部「＋」添加第一张卡片；加完记得点「保存cdb」导出';
      }
      grid.innerHTML = `<div class="empty">${msg}</div>`;
      return;
    }
    let html = state.items.map(cardHTML).join('');
    if (!state.exhausted && state.dbReady && state.mode === 'db') {
      html += `<button class="load-more" id="loadMore">加载更多…</button>`;
    }
    grid.innerHTML = html;
    grid.querySelectorAll('.card').forEach(el => {
      el.addEventListener('click', () => openSheet(Number(el.dataset.id), false));
    });
    const lm = $('#loadMore');
    if (lm) lm.onclick = () => loadPage(false);
  }

  // ---------- 详情 / 编辑 抽屉 ----------
  function findCard(id) { return state.items.find(x => x.id === id); }

  function openSheet(id, edit) {
    selectedId = id; editing = !!edit;
    const c = findCard(id);
    if (!c) return;
    // 只在查看态绑定 view 按钮编辑态没有 editBtn/delBtn，绑定会对 null 赋值抛错，
    // 导致「＋新建卡片」直接进编辑时抽屉弹不出来
    if (editing) { sheet.innerHTML = editorHTML(c); bindEditor(c); }
    else { sheet.innerHTML = viewHTML(c); bindView(c); }
    sheetMask.classList.add('show'); sheet.classList.add('show');
  }
  function closeSheet() {
    sheetMask.classList.remove('show'); sheet.classList.remove('show');
    editing = false; selectedId = null;
  }

  function viewHTML(c) {
    const d = YGO.decodeType(c.type);
    const big = cardHTML(c);
    const info = [];
    if (d.kind === 'monster') {
      info.push(`种族：${YGO.raceNames(c.race)}`);
      info.push(`属性：${YGO.attrEntry(c.attribute || 0).en}`);
    }
    info.push(`卡片密码：${String(c.id).padStart(8, '0')}`);
    const al = aliasEntry(c);
    if (al) info.push(`别名指向：${al.id}${al.name ? '（' + esc(al.name) + '）' : ''}`);
    if (c.ot != null) info.push(`OT：${c.ot}`);
    const scArr = (c.setcodes && c.setcodes.some(x => x)) ? c.setcodes.filter(x => x) : (c.setcode || []);
    if (scArr.length) info.push(`系列码：${setcodeLabel(scArr)}`);
    return `
      <div class="sheet-head">
        <div class="sheet-title">${esc(c.name)}</div>
        <button class="sheet-close" id="closeBtn">关闭</button>
      </div>
      <div class="big-card-wrap">${big}</div>
      <div class="card-info">${info.map(i => `<span>${i}</span>`).join('')}</div>
      <div class="sheet-actions">
        <button class="btn-edit" id="editBtn">编辑</button>
        <button class="btn-cdb" id="exportCardBtn">导出cdb</button>
        <button class="btn-del" id="delBtn">删除</button>
      </div>`;
  }

  function bindView(c) {
    $('#closeBtn').onclick = closeSheet;
    $('#editBtn').onclick = () => openSheet(c.id, true);
    // 单卡导出：打包成独立 .cdb（命名 c <id>.cdb，与 DataEditorY 惯例一致）
    const ex = $('#exportCardBtn');
    if (ex) ex.onclick = async () => {
      try {
        const bytes = DBClient.exportCardsAsCdb([c]);
        const uri = await YGOBridge.saveCdb(bytes, 'c ' + c.id + '.cdb');
        if (uri) alert('已保存到：' + uri);
      } catch (e) { alert('导出失败：' + (e.message || e)); }
    };
    $('#delBtn').onclick = () => {
      if (state.dbReady && state.mode === 'db') {
        try { DBClient.remove(c.id); DBClient.markDirty(); renderTabs(); } catch (e) { alert('删除失败：' + e.message); return; }
      }
      const i = state.items.findIndex(x => x.id === c.id);
      if (i >= 0) state.items.splice(i, 1);
      renderGrid(); closeSheet();
    };
  }

  // ---------- 编辑表单 ----------
  const MONSTER_FLAGS = [
    ['normal', '通常'], ['effect', '效果'], ['ritual', '仪式'], ['fusion', '融合'],
    ['synchro', '同步'], ['xyz', 'XYZ'], ['link', '连接'], ['pendulum', '灵摆'],
    ['tuner', '调整'], ['spirit', '灵魂'], ['union', '联合'], ['dual', '二重'],
    ['flip', '反转'], ['toon', '卡通'], ['specialSummon', '特殊召唤'], ['token', '衍生物']
  ];
  const SPELL_FLAGS = [['ritual', '仪式'], ['quickplay', '速攻'], ['continuous', '永续'], ['equip', '装备'], ['field', '场地']];
  const TRAP_FLAGS = [['trapmonster', '陷阱怪兽'], ['counter', '反击'], ['continuous', '永续']];
  const EDITABLE_TYPE_MASK = [0x1, 0x2, 0x4, 0x8, 0x10, 0x20, 0x40, 0x80,
    0x200, 0x400, 0x800, 0x1000, 0x2000, 0x4000, 0x10000, 0x20000,
    0x40000, 0x80000, 0x100000, 0x200000, 0x400000, 0x800000,
    0x1000000, 0x2000000, 0x4000000].reduce((mask, bit) => mask | bit, 0);

  function flagCheckboxes(kind, d) {
    const map = kind === 'spell' ? SPELL_FLAGS : kind === 'trap' ? TRAP_FLAGS : MONSTER_FLAGS;
    return map.map(([k, label]) => `<label><input type="checkbox" data-flag="${k}" ${d[k] ? 'checked' : ''}/>${label}</label>`).join('');
  }

  function editorHTML(c) {
    const d = YGO.decodeType(c.type);
    const kind = d.kind;
    const attrValue = c.attribute >>> 0, raceValue = c.race >>> 0;
    const attrOpts = `<option value="0" ${attrValue === 0 ? 'selected' : ''}>未设置</option>` +
      Object.keys(YGO.ATTR).map(k => `<option value="${k}" ${attrValue === Number(k) ? 'selected' : ''}>${YGO.ATTR[k].name} ${YGO.ATTR[k].en}</option>`).join('') +
      (attrValue && !YGO.ATTR[attrValue] ? `<option value="${attrValue}" selected>原值 ${attrValue}</option>` : '');
    const raceOpts = `<option value="0" ${raceValue === 0 ? 'selected' : ''}>未设置</option>` +
      Object.keys(YGO.RACE).map(k => `<option value="${k}" ${raceValue === Number(k) ? 'selected' : ''}>${YGO.RACE[k]}</option>`).join('') +
      (raceValue && !YGO.RACE[raceValue] ? `<option value="${raceValue}" selected>原值 ${raceValue}</option>` : '');
    const isLink = d.link, isPend = d.pendulum;
    const sl = (c.scaleL != null) ? c.scaleL : c.lscale;
    const sr = (c.scaleR != null) ? c.scaleR : c.rscale;
    const sc = (c.setcodes || []).slice();
    while (sc.length < 4) sc.push(0);
    const al = aliasEntry(c);
    const aliasNote = al
      ? `<div class="field-hint">本卡别名指向 ${al.id}${al.name ? '（' + esc(al.name) + '）' : ''}——游戏内按规则显示目标卡名，此字段存的是原始名</div>`
      : '';
    return `
      <div class="sheet-head">
        <div class="sheet-title">编辑卡片</div>
        <button class="sheet-close" id="closeBtn">取消</button>
      </div>
      <div class="field"><label>卡片密码</label><input id="f-pass" value="${String(c.id).padStart(8, '0')}" readonly/></div>
      <div class="field"><label>卡名</label><input id="f-name" value="${esc(c.name)}"/>${aliasNote}</div>
      <div class="field"><label>描述</label><textarea id="f-desc">${esc(c.desc)}</textarea></div>
      <div class="row2">
        <div class="field"><label>种类</label>
          <select id="f-kind">
            <option value="monster" ${kind === 'monster' ? 'selected' : ''}>怪兽</option>
            <option value="spell" ${kind === 'spell' ? 'selected' : ''}>魔法</option>
            <option value="trap" ${kind === 'trap' ? 'selected' : ''}>陷阱</option>
          </select>
        </div>
        <div class="field"><label>类型标记</label><div class="flag-grid" id="f-flags">${flagCheckboxes(kind, d)}</div></div>
      </div>
      <div class="field"><label>系列码（最多 4 个，0–65535）</label>
        <div class="row4">
          <div class="sc-cell"><input id="f-sc0" class="sc-input" type="number" min="0" max="65535" placeholder="①" value="${sc[0] ? sc[0] : ''}"/><span class="sc-name" id="scn0"></span></div>
          <div class="sc-cell"><input id="f-sc1" class="sc-input" type="number" min="0" max="65535" placeholder="②" value="${sc[1] ? sc[1] : ''}"/><span class="sc-name" id="scn1"></span></div>
          <div class="sc-cell"><input id="f-sc2" class="sc-input" type="number" min="0" max="65535" placeholder="③" value="${sc[2] ? sc[2] : ''}"/><span class="sc-name" id="scn2"></span></div>
          <div class="sc-cell"><input id="f-sc3" class="sc-input" type="number" min="0" max="65535" placeholder="④" value="${sc[3] ? sc[3] : ''}"/><span class="sc-name" id="scn3"></span></div>
        </div>
        <input id="f-sc-search" type="search" placeholder="中文系列名或代码，如 0x1DB" autocomplete="off" aria-label="检索系列码"/>
        <div class="sc-search-hint" id="f-sc-target"></div>
        <div class="sc-search-results" id="f-sc-results"></div>
      </div>
      <div id="monster-fields" style="${kind === 'monster' ? '' : 'display:none'}">
        <div class="row2">
          <div class="field"><label>属性</label><select id="f-attr">${attrOpts}</select></div>
          <div class="field"><label>种族</label><select id="f-race">${raceOpts}</select></div>
        </div>
        <div class="row2">
          <div class="field"><label id="l-level">${isLink ? '连接数' : (d.xyz ? '阶级' : '等级')}</label>
            <input id="f-level" type="number" min="0" max="255" step="1" value="${numOrEmpty(c.level)}"/></div>
          <div class="field"><label>ATK</label><input id="f-atk" type="number" value="${numOrEmpty(c.atk)}"/></div>
        </div>
        <div class="field" id="def-field" style="${isLink ? 'display:none' : ''}">
          <label>DEF</label><input id="f-def" type="number" value="${numOrEmpty(c.def)}"/></div>
        <div class="field" id="pend-field" style="${isPend ? '' : 'display:none'}">
          <label>灵摆刻度（左/右）</label>
          <div class="row2">
            <input id="f-scaleL" type="number" min="0" max="255" step="1" placeholder="左" value="${numOrEmpty(sl)}"/>
            <input id="f-scaleR" type="number" min="0" max="255" step="1" placeholder="右" value="${numOrEmpty(sr)}"/>
          </div>
        </div>
        <div class="field" id="link-field" style="${isLink ? '' : 'display:none'}">
          <label>连接箭头（点击切换）</label>
          <div class="link-toggles" id="f-link"></div>
        </div>
      </div>
      <div class="sheet-actions">
        <button class="btn-save" id="saveBtn">保存</button>
      </div>`;
  }

  function bindEditor(c) {
    $('#closeBtn').onclick = closeSheet;
    const syncSubtypeFields = () => {
      const f = readFlags();
      $('#monster-fields').style.display = f.kind === 'monster' ? '' : 'none';
      $('#pend-field').style.display = f.pendulum ? '' : 'none';
      $('#link-field').style.display = f.link ? '' : 'none';
      $('#def-field').style.display = f.link ? 'none' : '';
      $('#l-level').textContent = f.link ? '连接数' : (f.xyz ? '阶级' : '等级');
    };
    $('#f-kind').onchange = () => {
      const k = $('#f-kind').value;
      const d = { kind: k };
      $('#f-flags').innerHTML = flagCheckboxes(k, d);
      syncSubtypeFields();
    };
    $('#f-flags').addEventListener('change', e => {
      if (!e.target.matches('input[data-flag]')) return;
      syncSubtypeFields();
    });
    syncSubtypeFields();
    const selectedLinkMarkers = renderLinkToggles(c);
    for (let i = 0; i < 4; i++) {
      const inp = $('#f-sc' + i);
      if (!inp) continue;
      const upd = () => {
        const sp = document.getElementById('scn' + i);
        if (sp) sp.textContent = inp.value ? `${setcodeName(inp.value) || '未收录'} · ${setcodeHex(inp.value)}` : '';
      };
      inp.addEventListener('input', upd); upd();
    }
    let targetSlot = [0, 1, 2, 3].find(i => !$('#f-sc' + i).value);
    if (targetSlot === undefined) targetSlot = 0;
    const showTarget = () => {
      $('#f-sc-target').textContent = `点击结果填入第 ${targetSlot + 1} 格；点上方数字框可切换目标`;
      for (let i = 0; i < 4; i++) $('#f-sc' + i).classList.toggle('sc-target', i === targetSlot);
    };
    for (let i = 0; i < 4; i++) $('#f-sc' + i).addEventListener('focus', () => { targetSlot = i; showTarget(); });
    showTarget();
    const search = $('#f-sc-search'), results = $('#f-sc-results');
    search.addEventListener('input', () => {
      const q = search.value.trim().toLocaleLowerCase();
      if (!q) { results.innerHTML = ''; return; }
      const matches = Object.entries(window.YGO_SETNAMES || {})
        .filter(([code, name]) => code.includes(q) || setcodeHex(code).toLowerCase().includes(q) || String(name).toLocaleLowerCase().includes(q))
        .slice(0, 30);
      results.innerHTML = matches.length
        ? matches.map(([code, name]) => `<button type="button" data-code="${code}"><span>${esc(name)}</span><small>${code} / ${setcodeHex(code)}</small></button>`).join('')
        : '<div class="sc-search-empty">没有找到对应系列码</div>';
    });
    results.addEventListener('click', e => {
      const btn = e.target.closest('button[data-code]');
      if (!btn) return;
      const input = $('#f-sc' + targetSlot);
      input.value = btn.dataset.code;
      input.dispatchEvent(new Event('input'));
      search.value = '';
      results.innerHTML = '';
      const empty = [0, 1, 2, 3].find(i => !$('#f-sc' + i).value);
      if (empty !== undefined) targetSlot = empty;
      showTarget();
    });
    $('#saveBtn').onclick = () => saveCard(c, selectedLinkMarkers());
  }

  function renderLinkToggles(c) {
    const box = $('#f-link');
    if (!box) return;
    const order = ['top_left', 'top', 'top_right', 'left', 'center', 'right', 'bottom_left', 'bottom', 'bottom_right'];
    const map = { top_left: '↖', top: '↑', top_right: '↗', left: '←', right: '→', bottom_left: '↙', bottom: '↓', bottom_right: '↘' };
    const cur = new Set(c.linkMarkers || []);
    box.innerHTML = order.map(k => k === 'center'
      ? '<button class="center" disabled>●</button>'
      : `<button data-lm="${k}" class="${cur.has(k) ? 'on' : ''}">${map[k]}</button>`).join('');
    box.querySelectorAll('button[data-lm]').forEach(b => {
      b.onclick = () => {
        const k = b.dataset.lm;
        if (cur.has(k)) { cur.delete(k); b.classList.remove('on'); }
        else { cur.add(k); b.classList.add('on'); }
      };
    });
    return () => [...cur];
  }

  function readFlags() {
    const d = { kind: $('#f-kind').value };
    document.querySelectorAll('#f-flags input[data-flag]').forEach(i => { d[i.dataset.flag] = i.checked; });
    return d;
  }

  function buildType(f, originalType) {
    const sameKind = YGO.decodeType(originalType).kind === f.kind;
    let t = sameKind ? (originalType & ~EDITABLE_TYPE_MASK) : 0;
    if (f.kind === 'monster') {
      // 旧库存在仅带 TOKEN 位、不带 MONSTER 位的卡；原样编辑时保留这种编码。
      if (!sameKind || (originalType & 0x7)) t |= 0x1;
      if (f.normal) t |= 0x10;
      if (f.effect) t |= 0x20;
      if (f.fusion) t |= 0x40;
      if (f.ritual) t |= 0x80;
      if (f.spirit) t |= 0x200;
      if (f.union) t |= 0x400;
      if (f.dual) t |= 0x800;
      if (f.tuner) t |= 0x1000;
      if (f.flip) t |= 0x200000;
      if (f.toon) t |= 0x400000;
      if (f.specialSummon) t |= 0x2000000;
      if (f.token) t |= 0x4000;
      if (f.synchro) t |= 0x2000;
      if (f.pendulum) t |= 0x1000000;
      if (f.xyz) t |= 0x800000;
      if (f.link) t |= 0x4000000;
    } else if (f.kind === 'spell') {
      t |= 0x2; if (f.ritual) t |= 0x80; if (f.quickplay) t |= 0x10000; if (f.continuous) t |= 0x20000;
      if (f.equip) t |= 0x40000; if (f.field) t |= 0x80000;
    } else if (f.kind === 'trap') {
      t |= 0x4; if (f.trapmonster) t |= 0x8; if (f.counter) t |= 0x100000; if (f.continuous) t |= 0x20000;
    }
    return t >>> 0;
  }

  function readUnsignedField(id, label, max) {
    const raw = $(id).value.trim();
    if (!raw) return 0;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`${label}必须是 0–${max} 的整数`);
    return value;
  }

  async function saveCard(c, selectedLinkMarkers) {
    const f = readFlags();
    let level = 0, lscale = 0, rscale = 0, sc;
    try {
      if (f.kind === 'monster') {
        level = readUnsignedField('#f-level', f.link ? '连接数' : (f.xyz ? '阶级' : '等级'), 255);
        if (f.pendulum) {
          lscale = readUnsignedField('#f-scaleL', '左灵摆刻度', 255);
          rscale = readUnsignedField('#f-scaleR', '右灵摆刻度', 255);
        }
      }
      sc = [0, 1, 2, 3].map(i => readUnsignedField('#f-sc' + i, `第 ${i + 1} 个系列码`, 65535));
    } catch (e) { alert(e.message); return; }
    const payload = {
      name: $('#f-name').value.trim() || '未命名',
      desc: $('#f-desc').value,
      type: buildType(f, c.type)
    };
    if (f.kind === 'monster') {
      payload.attribute = Number($('#f-attr').value);
      payload.race = Number($('#f-race').value);
      payload.level = level;
      payload.atk = Number($('#f-atk').value) || 0;
      if (f.link) { payload.def = null; payload.linkMarkers = selectedLinkMarkers; }
      else payload.def = Number($('#f-def').value) || 0;
      if (f.pendulum) {
        payload.lscale = lscale;
        payload.rscale = rscale;
      }
    } else {
      payload.attribute = 0; payload.race = 0; payload.level = 0; payload.atk = 0; payload.def = 0;
    }
    payload.setcodes = sc;
    if (state.dbReady) {
      try {
        const exists = DBClient.get(c.id);
        const saved = exists
          ? DBClient.update(c.id, payload)
          : DBClient.insert(Object.assign({ id: c.id, ot: c.ot || 2, alias: 0, category: 0 }, payload));
        Object.assign(c, saved);
        DBClient.markDirty(); renderTabs();
      } catch (e) { alert('保存到 CDB 失败：' + e.message); return; }
    } else {
      Object.assign(c, payload);
    }
    renderGrid();
    openSheet(c.id, false);
  }

  // ---------- 顶部/导航交互 ----------
  $('#searchInput').addEventListener('input', e => { filter.q = e.target.value; loadPage(true); });
  // 下拉值编码为「种类:子类」，如 monster:synchro / spell:normal
  $('#filterKind').addEventListener('change', e => {
    const v = e.target.value.split(':');
    filter.kind = v[0] || '';
    filter.sub = v[1] || '';
    loadPage(true);
  });

  document.querySelectorAll('.bottom-nav button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.bottom-nav button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      if (b.id === 'btnNew') newCard();
      else if (b.dataset.nav === 'search') $('#searchInput').focus();
    });
  });
  sheetMask.addEventListener('click', closeSheet);
  $('#btnExport').addEventListener('click', exportJSON);
  $('#btnOpen').addEventListener('click', onOpenClick);
  $('#btnNewFile').addEventListener('click', onNewFileClick);
  $('#btnExportCdb').addEventListener('click', saveCdb);
  $('#fileInput').addEventListener('change', onFilePicked);

  // 一键回到内置卡库（切到内置页签，不重复开）
  $('#btnResetDb').addEventListener('click', async () => {
    try {
      await DBClient.openBuiltin('./cards.cdb?v=20260912d');
      state.dbReady = true; state.mode = 'db';
      resetFilters(); closeSheet(); renderTabs();
      await loadPage(true);
    } catch (e) { alert('恢复内置卡库失败：' + (e.message || e)); }
  });

  // 打开外部 .cdb（Android 走 SAF 文件选择插件；Web 回退到 <input type=file>）
  async function onOpenClick() {
    if (window.YGOBridge && YGOBridge.hasPicker()) {
      try {
        const res = await YGOBridge.openExternalCdb();
        if (res) await openCdbBytes(res.bytes, res.name, 'file');
      } catch (e) { alert(e.message || '打开失败'); }
    } else {
      $('#fileInput').click();
    }
  }

  // 建立新的 .cdb 文档：只在内存里开新页签，保存时经「另存为」落盘
  async function onNewFileClick() {
    try {
      const bytes = DBClient.createEmpty();
      await openCdbBytes(bytes, uniqueDocName('new.cards.cdb'), 'new');
    } catch (e) { alert('建立文件失败：' + (e.message || e)); }
  }

  // 保存当前活动文档：Android 弹「另存为」，Web 走下载
  async function saveCdb() {
    if (!state.dbReady) { alert('当前为示例数据，没有可保存的 .cdb'); return; }
    try {
      const bytes = DBClient.exportBytes();
      const uri = await YGOBridge.saveCdb(bytes, DBClient.sourceName);
      DBClient.clearDirty();
      renderTabs();
      if (uri) alert('已保存到：' + uri);
    } catch (e) { alert('保存失败：' + (e.message || e)); }
  }

  // 把字节加载为新文档页签并刷新列表（web / 原生共用）
  async function openCdbBytes(bytes, name, kind) {
    try {
      DBClient.openBuffer(bytes, name, kind);
      state.dbReady = true; state.mode = 'db';
      closeSheet(); resetFilters(); renderTabs();
      await loadPage(true);
    } catch (e) { alert('打开失败：' + (e.message || e)); }
  }

  function newCard() {
    // 卡密查重：在内置官方库 + 所有打开的文档 + 库文件夹里的 cdb 现有 id 中查重，撞了重新取
    assignNewCardId().then(id => {
      const c = {
        id: id, name: '新卡片', desc: '', type: 17,
        ot: 2, alias: 0, setcode: [], setcodes: [0, 0, 0, 0], category: 0,
        attribute: 0x10, race: 0x2000, level: 4, atk: 0, def: 0, linkMarkers: []
      };
      state.items.unshift(c);
      openSheet(c.id, true);
    });
  }

  // 卡密范围：默认 9 亿段（避开官方 8 位密码段），可在「＋ → 卡密范围…」里手动调整
  // 取值范围为闭区间 [lo, hi]，持久化在 localStorage，重启后仍生效
  const DEFAULT_ID_RANGE = { lo: 900000000, hi: 900099998 };

  function getIdRange() {
    try {
      const raw = localStorage.getItem('ygo.idRange');
      if (raw) {
        const r = JSON.parse(raw);
        const lo = Math.floor(Number(r.lo));
        const hi = Math.floor(Number(r.hi));
        if (Number.isFinite(lo) && Number.isFinite(hi) && lo >= 1 && hi >= lo) return { lo, hi };
      }
    } catch (e) { /* 解析失败则用默认 */ }
    return { lo: DEFAULT_ID_RANGE.lo, hi: DEFAULT_ID_RANGE.hi };
  }

  function setIdRange(lo, hi) {
    try { localStorage.setItem('ygo.idRange', JSON.stringify({ lo: lo, hi: hi })); } catch (e) { /* ignore */ }
  }

  function resetIdRange() {
    try { localStorage.removeItem('ygo.idRange'); } catch (e) { /* ignore */ }
    return { lo: DEFAULT_ID_RANGE.lo, hi: DEFAULT_ID_RANGE.hi };
  }

  function drawCardId() {
    const r = getIdRange();
    return r.lo + Math.floor(Math.random() * (r.hi - r.lo + 1));
  }

  let builtinIds = new Set();   // 内置官方库 id 缓存（启动时灌入）
  let libIds = new Set();       // 库文件夹内所有 cdb 的 id 缓存
  let libScannedUri = null;     // 当前缓存对应的文件夹 uri（换文件夹/换会话时重扫）

  async function collectKnownIds() {
    const s = new Set(builtinIds);
    for (const d of DBClient.docs()) {
      for (const id of DBClient.idsOfDoc(d.id)) s.add(id);
    }
    const uri = YGOBridge.libFolder();
    if (uri && uri !== libScannedUri) {
      libIds = await scanLibFolder(uri);
      libScannedUri = uri;
    }
    for (const id of libIds) s.add(id);
    return s;
  }

  async function scanLibFolder(folderUri) {
    const s = new Set();
    const files = await YGOBridge.listLibraryCdb(folderUri);
    for (const f of files) {
      try {
        const b64 = await YGOBridge.readFileNative(f.uri);
        if (!b64) continue;
        for (const id of DBClient.idsFromBytes(YGOBridge.base64ToBytes(b64))) s.add(id);
      } catch (e) { /* 单个文件读不了就跳过 */ }
    }
    return s;
  }

  async function assignNewCardId() {
    try {
      const known = await collectKnownIds();
      const r = getIdRange();
      const span = r.hi - r.lo + 1;
      // 先随机试若干次（常见情况一次就中）
      const tries = Math.min(1000, span);
      for (let i = 0; i < tries; i++) {
        const id = drawCardId();
        if (!known.has(id)) return id;
      }
      // 随机命中率低（范围被大量占用 / 范围很小）：从随机起点线性找，保证不重复且不死循环
      const start = r.lo + Math.floor(Math.random() * span);
      for (let k = 0; k < span; k++) {
        const id = r.lo + ((start - r.lo + k) % span);
        if (!known.has(id)) return id;
      }
      alert('卡密范围 [' + r.lo + ', ' + r.hi + '] 内已无可用卡密，请到「＋ → 卡密范围…」调整');
      return drawCardId();
    } catch (e) {
      return drawCardId(); // 查重不可用（如 web 端没设库文件夹）时退化为纯随机
    }
  }

  // 强制重新扫描库文件夹，返回已知卡密集合（null = 没设库文件夹）
  async function refreshLib() {
    const uri = (window.YGOBridge && YGOBridge.libFolder()) || '';
    if (!uri) return null;
    libIds = await scanLibFolder(uri);
    libScannedUri = uri;
    return libIds;
  }

  function exportJSON() {
    const data = JSON.stringify(state.items, null, 2);
    YGOBridge.saveText(data, 'cards-export.json').then(uri => {
      if (uri) alert('已保存到：' + uri);
    }).catch(e => alert('导出失败：' + (e.message || e)));
  }

  function exportCdb() {
    if (!state.dbReady) { alert('当前为示例数据，没有可导出的 .cdb'); return; }
    const bytes = DBClient.exportBytes();
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'cards-modified.cdb'; a.click();
    URL.revokeObjectURL(url);
  }

  function onFilePicked(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      await openCdbBytes(new Uint8Array(reader.result), file.name);
    };
    reader.readAsArrayBuffer(file);
  }

  // 旧版纯下载导出（保留，用于「导出」按钮做 JSON 之外的备份）
  function exportCdb() {
    if (!state.dbReady) { alert('当前为示例数据，没有可导出的 .cdb'); return; }
    const bytes = DBClient.exportBytes();
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'cards-modified.cdb'; a.click();
    URL.revokeObjectURL(url);
  }

  // ---------- 启动：加载 sql.js + 内置卡库（优先用用户导入的库），失败回退示例 ----------
  (async function start() {
    try {
      await DBClient.init({ url: './cards.cdb' });
      let imported = null;
      if (window.YGOBridge && YGOBridge.isNative()) {
        try { imported = await YGOBridge.readInternal('cards.user.cdb'); } catch (e) { /* 旧包无此方法 */ }
      }
      if (imported) {
        // 用户导入过官方卡库：以它作为内置库
        DBClient.openBuffer(YGOBridge.base64ToBytes(imported), 'cards.cdb', 'builtin');
      } else {
        await DBClient.openBuiltin('./cards.cdb');
      }
      builtinIds = DBClient.idsOfDoc(DBClient.activeId); // 官方库 id 缓存，供新卡查重
      state.dbReady = true; state.mode = 'db';
    } catch (e) {
      console.warn('CDB 加载失败，回退示例数据：', e.message);
      state.dbReady = false; state.mode = 'sample';
    }
    renderTabs();
    loadPage(true);
    // 后台预扫描已记住的库文件夹：下次新建卡直接查重，无需等待（失败不影响使用）
    (async () => {
      try {
        if (window.YGOBridge && YGOBridge.hasPicker() && YGOBridge.libFolder()) await refreshLib();
      } catch (e) { /* ignore */ }
    })();
  })();

  // ＋菜单：新建 / 打开 / 内置卡库 / 库文件夹
  $('#pmNew').addEventListener('click', () => { hidePlusMenu(); onNewFileClick(); });
  $('#pmOpen').addEventListener('click', () => { hidePlusMenu(); onOpenClick(); });
  $('#pmFolder').addEventListener('click', async () => {
    hidePlusMenu();
    if (!(window.YGOBridge && YGOBridge.hasPicker())) { alert('仅安卓 App 支持选择库文件夹'); return; }
    try {
      const uri = await YGOBridge.pickLibraryFolder();
      if (!uri) return; // 取消
      YGOBridge.setLibFolder(uri);   // 记住选择（localStorage），下次启动自动生效
      let msg = '库文件夹已记住：\n以后「保存cdb」会默认打开这个目录，新建卡密码也会对它里面的库查重\n\n';
      try {
        const ids = await refreshLib();
        const n = ids ? ids.size : 0;
        msg += (n > 0) ? ('本次扫描到 ' + n + ' 个卡密')
                       : '该文件夹内没有找到 .cdb（或里面的库不含卡密）';
      } catch (e) {
        msg += '⚠ 扫描失败：' + (e.message || e);
      }
      alert(msg);
    } catch (e) { alert('选择失败：' + (e.message || e)); }
  });

  // 刷新卡库：强制重扫已记住的库文件夹（库文件更新后不用重新选文件夹）
  $('#pmRefreshLib').addEventListener('click', async () => {
    hidePlusMenu();
    if (!(window.YGOBridge && YGOBridge.hasPicker())) { alert('仅安卓 App 支持刷新卡库'); return; }
    if (!YGOBridge.libFolder()) { alert('还没选择库文件夹，请先点「选择库文件夹…」'); return; }
    try {
      const ids = await refreshLib();
      alert('卡库已刷新：\n共 ' + (ids ? ids.size : 0) + ' 个已知卡密');
    } catch (e) { alert('刷新失败：' + (e.message || e)); }
  });

  // 卡密范围：手动调整生成区间（闭区间，持久化保存）
  $('#pmIdRange').addEventListener('click', () => {
    hidePlusMenu();
    const cur = getIdRange();
    const ans = prompt(
      '卡密生成范围（闭区间，含两端）\n' +
      '格式：起始-结束　例：900000000-900099998\n\n' +
      '留空并确定 = 恢复默认 9 亿段',
      cur.lo + '-' + cur.hi
    );
    if (ans === null) return; // 取消
    const t = String(ans).trim();
    if (!t) {
      const d = resetIdRange();
      alert('已恢复默认范围：[' + d.lo + ', ' + d.hi + ']');
      return;
    }
    const m = t.match(/^(\d+)\s*[-~,\s]\s*(\d+)$/);
    if (!m) { alert('格式不对，请写成「起始-结束」，例如 900000000-900099998'); return; }
    const lo = parseInt(m[1], 10), hi = parseInt(m[2], 10);
    if (!(lo >= 1) || !(hi >= lo)) { alert('范围无效：需为整数且满足 1 ≤ 起始 ≤ 结束'); return; }
    setIdRange(lo, hi);
    alert('卡密范围已保存：[' + lo + ', ' + hi + ']\n共 ' + (hi - lo + 1) + ' 个可用号');
  });

  // 手动导入官方卡库：选一个 .cdb（默认打开库文件夹），校验后存入 App 内部存储并立即生效
  $('#pmImportLib').addEventListener('click', async () => {
    hidePlusMenu();
    if (!(window.YGOBridge && YGOBridge.isNative())) { alert('仅安卓 App 支持导入官方卡库'); return; }
    let res = null;
    try {
      res = await YGOBridge.openExternalCdb(); // 默认落在库文件夹
    } catch (e) {
      if ((e.message || '') !== '未选择文件') alert('导入失败：' + (e.message || e));
      return;
    }
    if (!res) return;
    try {
      const count = DBClient.validateBytes(res.bytes); // 不合格会 throw
      await YGOBridge.saveInternal('cards.user.cdb', YGOBridge.bytesToBase64(res.bytes));
      // 替换当前内置页签
      const bi = DBClient.docs().find(d => d.kind === 'builtin');
      if (bi) DBClient.closeDoc(bi.id);
      DBClient.openBuffer(res.bytes, 'cards.cdb', 'builtin');
      builtinIds = DBClient.idsOfDoc(DBClient.activeId);
      state.dbReady = true; state.mode = 'db';
      resetFilters(); closeSheet(); renderTabs();
      await loadPage(true);
      alert('官方卡库已更新：共 ' + count + ' 张卡\n（下次启动自动使用新库）');
    } catch (e) { alert('导入失败：' + (e.message || e)); }
  });
  $('#pmBuiltin').addEventListener('click', async () => {
    hidePlusMenu();
    try {
      await DBClient.openBuiltin('./cards.cdb?v=20260912d');
      state.dbReady = true; state.mode = 'db';
      resetFilters(); closeSheet(); renderTabs();
      await loadPage(true);
    } catch (e) { alert('打开内置卡库失败：' + (e.message || e)); }
  });
  plusMask.addEventListener('click', hidePlusMenu);
})();
