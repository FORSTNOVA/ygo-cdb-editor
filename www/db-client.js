/*
 * 客户端 CDB 数据层（sql.js / wasm）——多文档版
 * - 支持同时打开多个库（内置卡库 / 打开的文件 / 新建文件），页签切换
 * - 所有读写操作作用于「当前活动文档」，由 setActive / openBuffer / closeDoc 管理
 * - 类型与属性位对照 DataEditorY 的 taxonomy.ts；CDB 打包对照 ygopro-cdb-encode-rs
 */
(function () {
  'use strict';

  // ---- 位定义（对照 ygopro-cdb-encode-rs / server.py）----
  const PENDULUM = 0x1000000;
  const LINK = 0x4000000;
  const LINK_MARKERS = {
    bottom_left: 0x1, bottom: 0x2, bottom_right: 0x4, left: 0x8,
    right: 0x20, top_left: 0x40, top: 0x80, top_right: 0x100
  };
  const MARKER_KEYS = Object.keys(LINK_MARKERS);
  const ATTR = { 0x1: 'EARTH', 0x2: 'WATER', 0x4: 'FIRE', 0x8: 'WIND', 0x10: 'LIGHT', 0x20: 'DARK', 0x40: 'DIVINE' };
  const RACE = { 0x1: '战士', 0x2: '魔法师', 0x4: '天使', 0x8: '恶魔', 0x10: '不死', 0x20: '机械', 0x40: '水', 0x80: '炎', 0x100: '岩石', 0x200: '鸟兽', 0x400: '植物', 0x800: '昆虫', 0x1000: '雷', 0x2000: '龙', 0x4000: '兽', 0x8000: '兽战士', 0x10000: '恐龙', 0x20000: '鱼', 0x40000: '海龙', 0x80000: '爬虫', 0x100000: '念动力', 0x200000: '幻神兽', 0x400000: '创造神', 0x800000: '幻龙', 0x1000000: '电子界', 0x2000000: '幻想魔' };

  let SQL = null;
  let seq = 0;
  // 打开的文档：{ id, name, kind: 'builtin'|'file'|'new', dirty, db }
  const docs = [];
  let activeId = null;

  function activeDoc() {
    for (const d of docs) if (d.id === activeId) return d;
    return null;
  }
  function activeDb() {
    const d = activeDoc();
    return d ? d.db : null;
  }

  function query(sql, params) {
    const db = activeDb();
    if (!db) return [];
    const stmt = db.prepare(sql);
    if (params && params.length) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  // 把最多 4 个系列码打包成 int64（第 i 个码落在 (i*16) 位）；空/越界值按 0 处理
  // sql.js 不能直接绑定 BigInt；按有符号 int64 转成十进制文本，再由 SQLite CAST 精确写入。
  function packSetcode(arr) {
    const codes = (arr || []).slice(0, 4).map(x => {
      let v = Number(x); if (!isFinite(v)) v = 0;
      return v < 0 ? 0 : (v > 0xffff ? 0xffff : Math.floor(v));
    });
    let packed = 0n;
    for (let i = 0; i < 4; i++) packed |= BigInt(codes[i] || 0) << BigInt(16 * i);
    return BigInt.asIntN(64, packed).toString();
  }

  // 把卡对象编码成 datas 行参数（ot/alias/setcode/type/atk/def/level/race/attribute/category）
  function encodeCardRow(b) {
    const type = b.type >>> 0;
    const isLink = !!(type & LINK);
    const isPend = !!(type & PENDULUM);
    const level = (b.level || 0) & 0xff;
    let levelRaw = level;
    if (isPend) {
      const l = (b.lscale || 0) & 0xff, r = (b.rscale || 0) & 0xff;
      levelRaw = level | (r << 16) | (l << 24);
    }
    const defVal = isLink
      ? (b.linkMarkers || []).reduce((s, m) => s + (LINK_MARKERS[m] || 0), 0)
      : (b.def || 0);
    const setcodeRaw = packSetcode(b.setcodes != null ? b.setcodes : (b.setcode || []));
    return [b.ot || 2, b.alias || 0, setcodeRaw, type, b.atk || 0, defVal, levelRaw, b.race || 0, b.attribute || 0, b.category || 0];
  }

  // 建表语句逐字对齐 ygopro-cdb-encode-rs 的 CREATE_TABLE_STMT：
  // texts 必须含 str1..str16（DataEditorY 打开时会 INSERT ... str1..str16 SELECT FROM datas，缺列直接报错）
  const CREATE_DATAS_SQL = 'CREATE TABLE IF NOT EXISTS datas(id integer primary key, ot integer, alias integer, setcode integer, type integer, atk integer, def integer, level integer, race integer, attribute integer, category integer)';
  const CREATE_TEXTS_SQL = 'CREATE TABLE IF NOT EXISTS texts(id integer primary key, name text, desc text, str1 text, str2 text, str3 text, str4 text, str5 text, str6 text, str7 text, str8 text, str9 text, str10 text, str11 text, str12 text, str13 text, str14 text, str15 text, str16 text)';
  const INSERT_DATAS_SQL = 'INSERT OR REPLACE INTO datas(id,ot,alias,setcode,type,atk,def,level,race,attribute,category) VALUES (?,?,?,CAST(? AS INTEGER),?,?,?,?,?,?,?)';
  const INSERT_TEXTS_SQL = 'INSERT OR REPLACE INTO texts(id,name,desc,str1,str2,str3,str4,str5,str6,str7,str8,str9,str10,str11,str12,str13,str14,str15,str16) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';

  function insertInto(nd, card) {
    nd.run(INSERT_DATAS_SQL, [card.id].concat(encodeCardRow(card)));
    const strs = [];
    for (let i = 0; i < 16; i++) strs.push('');
    nd.run(INSERT_TEXTS_SQL, [card.id, card.name || '', card.desc || ''].concat(strs));
  }

  function decodeCard(r) {
    const type = r.type >>> 0;
    const isPend = !!(type & PENDULUM);
    const isLink = !!(type & LINK);
    const levelRaw = r.level >>> 0;
    const level = levelRaw & 0xff;
    const lscale = isPend ? (levelRaw >>> 24) & 0xff : null;
    const rscale = isPend ? (levelRaw >>> 16) & 0xff : null;
    const link = isLink ? MARKER_KEYS.filter(k => (r.def >>> 0) & LINK_MARKERS[k]) : [];
    const attrNames = Object.keys(ATTR).filter(k => (r.attribute >>> 0) & k).map(k => ATTR[k]);
    const raceNames = Object.keys(RACE).filter(k => (r.race >>> 0) & k).map(k => RACE[k]);
    let kind = 'monster';
    if (type & 0x1) kind = 'monster';
    else if (type & 0x2) kind = 'spell';
    else if (type & 0x4) kind = 'trap';
    // 系列码：int64 装最多 4 个 16-bit 字段，第 i 个码 = raw >> (i*16) & 0xFFFF
    // （对照 ygopro-cdb-encode-rs 的 packed_setcode / decode_setcode；>=0x8000 也按原值，不特殊变换）
    // 用低/高 32 位拆开读取，再用 BigInt 重组，避免 JS Number 在 >2^53 时丢精度（真实库有 3 张卡用到第 4 码）
    const setcodes = [0, 0, 0, 0];
    const raw64 = (BigInt((r.sc_lo >>> 0) || 0)) | (BigInt((r.sc_hi >>> 0) || 0) << 32n);
    let sv = raw64;
    for (let i = 0; i < 4; i++) { setcodes[i] = Number(sv & 0xffffn); sv >>= 16n; }
    const setcode = setcodes.filter(x => x);
    return {
      id: r.id, name: r.name, type, kind,
      ot: r.ot, alias: r.alias, setcode, setcodes, category: r.category,
      attribute: r.attribute >>> 0, attributeNames: attrNames,
      race: r.race >>> 0, raceNames,
      level, atk: r.atk, def: isLink ? null : r.def,
      lscale, rscale, linkMarkers: link,
      desc: r.desc || '', pendulumDesc: ''
    };
  }

  const DBClient = {
    get sourceName() { const d = activeDoc(); return d ? d.name : ''; },
    get activeId() { return activeId; },

    // 页签列表（不含 db 实例）
    docs() { return docs.map(d => ({ id: d.id, name: d.name, kind: d.kind, dirty: d.dirty })); },
    activeDoc() {
      const d = activeDoc();
      return d ? { id: d.id, name: d.name, kind: d.kind, dirty: d.dirty } : null;
    },
    setActive(id) { if (docs.some(d => d.id === id)) activeId = id; },

    // 关闭文档；若关的是活动文档则自动切到相邻页签。返回新的活动 id（全空时为 null）
    closeDoc(id) {
      const i = docs.findIndex(d => d.id === id);
      if (i < 0) return activeId;
      const closed = docs.splice(i, 1)[0];
      try { closed.db.close(); } catch (e) { /* ignore */ }
      if (activeId === id) {
        const nxt = docs[Math.min(i, docs.length - 1)];
        activeId = nxt ? nxt.id : null;
      }
      return activeId;
    },

    async init(opts) {
      opts = opts || {};
      if (!SQL) {
        SQL = await initSqlJs({ locateFile: f => (opts.vendor || './vendor/') + f });
      }
      return SQL;
    },

    // 打开内置卡库为文档；已存在则直接切过去（不重复开）
    async openBuiltin(url) {
      url = url || './cards.cdb';
      const existing = docs.find(d => d.kind === 'builtin');
      if (existing) { activeId = existing.id; return this.meta(); }
      const buf = await (await fetch(url)).arrayBuffer();
      return this.openBuffer(buf, url.split('/').pop().split('?')[0] || 'cards.cdb', 'builtin');
    },

    // 把字节作为新文档打开（追加页签并激活）。同名内置库已开时仅切换。
    openBuffer(arrayBuffer, name, kind) {
      if (!SQL) throw new Error('sql.js 尚未初始化');
      if (kind === 'builtin') {
        const existing = docs.find(d => d.kind === 'builtin');
        if (existing) { activeId = existing.id; return this.meta(); }
      }
      const doc = {
        id: ++seq,
        name: name || ('cards' + seq + '.cdb'),
        kind: kind || 'file',
        dirty: false,
        db: new SQL.Database(new Uint8Array(arrayBuffer))
      };
      docs.push(doc);
      activeId = doc.id;
      return this.meta();
    },

    // 文档重命名（新建文档首次保存后同步页签名）
    renameDoc(id, name) {
      const d = docs.find(x => x.id === id);
      if (d) d.name = name;
    },

    markDirty(id) {
      const d = docs.find(x => x.id === (id || activeId));
      if (d) d.dirty = true;
    },

    clearDirty(id) {
      const d = docs.find(x => x.id === (id || activeId));
      if (d) d.dirty = false;
    },

    // 某个已打开文档的全部卡 id（新建卡查重用）
    idsOfDoc(id) {
      const d = docs.find(x => x.id === id);
      const s = new Set();
      if (!d) return s;
      const stmt = d.db.prepare('SELECT id FROM datas');
      while (stmt.step()) s.add(stmt.get()[0]);
      stmt.free();
      return s;
    },

    // 从裸 cdb 字节读全部卡 id（不进页签，用完即弃）
    idsFromBytes(bytes) {
      if (!SQL) throw new Error('sql.js 尚未初始化');
      const nd = new SQL.Database(new Uint8Array(bytes));
      try {
        const stmt = nd.prepare('SELECT id FROM datas');
        const s = new Set();
        while (stmt.step()) s.add(stmt.get()[0]);
        stmt.free();
        return s;
      } finally {
        nd.close();
      }
    },

    // 校验裸字节是否为可用 CDB（datas+texts 表齐全），返回卡数；不合格直接 throw
    validateBytes(bytes) {
      if (!SQL) throw new Error('sql.js 尚未初始化');
      const nd = new SQL.Database(new Uint8Array(bytes));
      try {
        const tables = nd.exec("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('datas','texts')");
        if (!tables.length || tables[0].values[0][0] < 2) {
          throw new Error('不是有效的 CDB（缺少 datas/texts 表）');
        }
        const r = nd.exec('SELECT COUNT(*) FROM datas');
        return r[0].values[0][0];
      } finally {
        nd.close();
      }
    },

    meta() {
      const row = query('SELECT COUNT(*) AS c FROM datas');
      return { total: row.length ? row[0].c : 0, source: this.sourceName };
    },

    list({ q = '', kind = '', sub = '', offset = 0, limit = 60 } = {}) {
      const where = [], params = [];
      if (q) { where.push('(t.name LIKE ? OR t.desc LIKE ?)'); params.push('%' + q + '%', '%' + q + '%'); }
      if (kind) {
        const bit = { monster: 0x1, spell: 0x2, trap: 0x4 }[kind];
        // 旧库有仅设置 TOKEN(0x4000) 而未设置 MONSTER(0x1) 的衍生物。
        where.push(kind === 'monster'
          ? '((d.type & 1) != 0 OR ((d.type & 7) = 0 AND (d.type & 16384) != 0))'
          : '(d.type & ' + bit + ') != 0');
      }
      // 子类过滤：normal 是特殊语义（该种类下不带任何子类标记），其余直接按位与
      if (sub === 'normal') {
        if (kind === 'monster') where.push('(d.type & 16) != 0');
        else if (kind === 'spell') where.push('((d.type & 2) != 0 AND (d.type & 983168) = 0)');   // 排除 0x10000|0x20000|0x40000|0x80000|0x80
        else if (kind === 'trap') where.push('((d.type & 4) != 0 AND (d.type & 1179648) = 0)');  // 排除 0x100000|0x20000
      } else if (sub) {
        const bits = {
          effect: 0x20, ritual: 0x80, fusion: 0x40, synchro: 0x2000, xyz: 0x800000,
          link: 0x4000000, pendulum: 0x1000000, tuner: 0x1000, union: 0x400,
          dual: 0x800, flip: 0x200000, token: 0x4000,
          quickplay: 0x10000, continuous: 0x20000, equip: 0x40000, field: 0x80000,
          counter: 0x100000
        };
        if (bits[sub]) where.push('(d.type & ' + bits[sub] + ') != 0');
      }
      const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
      const total = query('SELECT COUNT(*) AS c FROM datas d JOIN texts t ON d.id=t.id' + w, params)[0].c;
      const rows = query(
        'SELECT d.*, t.name, t.desc, (d.setcode & 4294967295) AS sc_lo, ((d.setcode >> 32) & 4294967295) AS sc_hi FROM datas d JOIN texts t ON d.id=t.id' + w +
        ' ORDER BY d.id LIMIT ? OFFSET ?', params.concat([limit, offset]));
      return { total, offset, limit, items: rows.map(decodeCard) };
    },

    get(id) {
      const rows = query('SELECT d.*, t.name, t.desc, (d.setcode & 4294967295) AS sc_lo, ((d.setcode >> 32) & 4294967295) AS sc_hi FROM datas d JOIN texts t ON d.id=t.id WHERE d.id=?', [id]);
      return rows.length ? decodeCard(rows[0]) : null;
    },

    update(id, b) {
      const type = b.type >>> 0;
      const isLink = !!(type & LINK);
      const isPend = !!(type & PENDULUM);
      const level = (b.level || 0) & 0xff;
      let levelRaw = level;
      if (isPend) {
        const l = (b.lscale || 0) & 0xff, r = (b.rscale || 0) & 0xff;
        levelRaw = level | (r << 16) | (l << 24);
      }
      const defVal = isLink
        ? (b.linkMarkers || []).reduce((s, m) => s + (LINK_MARKERS[m] || 0), 0)
        : (b.def || 0);
      const setcodeRaw = packSetcode(b.setcodes != null ? b.setcodes : (b.setcode || []));
      query('UPDATE datas SET type=?,atk=?,def=?,level=?,race=?,attribute=?,setcode=CAST(? AS INTEGER) WHERE id=?',
        [type, b.atk || 0, defVal, levelRaw, b.race || 0, b.attribute || 0, setcodeRaw, id]);
      query('UPDATE texts SET name=?,desc=? WHERE id=?', [b.name || '', b.desc || '', id]);
      return this.get(id);
    },

    // 导出当前活动文档为字节，供下载 / SAF 写回
    exportBytes() {
      const db = activeDb();
      if (!db) throw new Error('没有打开的文档');
      return db.export();
    },

    // 构建一个新的空 .cdb（schema 与真实库一致），返回字节
    createEmpty() {
      if (!SQL) throw new Error('sql.js 尚未初始化');
      const nd = new SQL.Database();
      nd.run(CREATE_DATAS_SQL);
      nd.run(CREATE_TEXTS_SQL);
      const bytes = nd.export();
      nd.close();
      return bytes;
    },

    // 把若干卡打包成一份独立的新 .cdb（导出单张 DIY 卡用，命名惯例 c <id>.cdb）
    exportCardsAsCdb(cards) {
      if (!SQL) throw new Error('sql.js 尚未初始化');
      const nd = new SQL.Database();
      nd.run(CREATE_DATAS_SQL);
      nd.run(CREATE_TEXTS_SQL);
      for (const c of (cards || [])) insertInto(nd, c);
      const bytes = nd.export();
      nd.close();
      return bytes;
    },

    // 新增（或整体替换）一张卡：datas + texts 全字段写入（str1..16 置空串）
    insert(card) {
      const db = activeDb();
      if (!db) throw new Error('没有打开的文档');
      insertInto(db, card);
      return this.get(card.id);
    },

    // 从库中删除一张卡（datas + texts）
    remove(id) {
      query('DELETE FROM datas WHERE id=?', [id]);
      query('DELETE FROM texts WHERE id=?', [id]);
    },

    close() {
      for (const d of docs) { try { d.db.close(); } catch (e) { /* ignore */ } }
      docs.length = 0; activeId = null;
    }
  };

  window.DBClient = DBClient;
})();
