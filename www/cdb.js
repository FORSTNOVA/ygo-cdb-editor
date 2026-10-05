// YGOPro .cdb 字段解码（位定义对照工作区 ygopro-cdb-encode-rs / 真实 cards.cdb 实测）
// 类型位对照 ygopro-cdb-encode-rs/src/model.rs 与 DataEditorY/src/lib/domain/card/taxonomy.ts
//   TYPE_MONSTER=0x1 SPELL=0x2 TRAP=0x4 FUSION=0x40 RITUAL=0x80 TOKEN=0x4000
//   SYNCHRO=0x2000 XYZ=0x800000 PENDULUM=0x1000000 LINK=0x4000000
//   魔法 速攻=0x10000 永续=0x20000 装备=0x40000 场地=0x80000 仪式=0x80；陷阱 反击=0x100000 永续=0x20000
//   packed_level = level | (rscale<<16) | (lscale<<24)
//   link 怪兽的 def 列存放 link_marker 位掩码
// 属性 / 种族 在真实 cdb 中均为位掩码（非 1..N 小整数）
const YGO = (function () {
  // 属性位掩码
  const ATTR = {
    0x1: { name: '地', en: 'EARTH' },
    0x2: { name: '水', en: 'WATER' },
    0x4: { name: '炎', en: 'FIRE' },
    0x8: { name: '风', en: 'WIND' },
    0x10: { name: '光', en: 'LIGHT' },
    0x20: { name: '闇', en: 'DARK' },
    0x40: { name: '神', en: 'DIVINE' }
  };
  // 种族位掩码
  const RACE = {
    0x1: '战士', 0x2: '魔法师', 0x4: '天使', 0x8: '恶魔', 0x10: '不死', 0x20: '机械',
    0x40: '水', 0x80: '炎', 0x100: '岩石', 0x200: '鸟兽', 0x400: '植物', 0x800: '昆虫',
    0x1000: '雷', 0x2000: '龙', 0x4000: '兽', 0x8000: '兽战士', 0x10000: '恐龙',
    0x20000: '鱼', 0x40000: '海龙', 0x80000: '爬虫', 0x100000: '念动力', 0x200000: '幻神兽',
    0x400000: '创造神', 0x800000: '幻龙', 0x1000000: '电子界', 0x2000000: '幻想魔'
  };
  // 连接箭头位掩码
  const LINK_MARKERS = {
    bottom_left: 0x1, bottom: 0x2, bottom_right: 0x4, left: 0x8,
    right: 0x20, top_left: 0x40, top: 0x80, top_right: 0x100
  };

  function decodeType(type) {
    const t = type >>> 0;
    let kind = 'monster';
    if (t & 0x1) kind = 'monster';
    else if (t & 0x2) kind = 'spell';
    else if (t & 0x4) kind = 'trap';
    const monster = kind === 'monster';
    const d = {
      kind,
      normal: !!(t & 0x10),
      effect: !!(t & 0x20),
      fusion: !!(t & 0x40),
      ritual: !!(t & 0x80),
      trapmonster: !!(t & 0x8),
      spirit: !!(t & 0x200),
      union: !!(t & 0x400),
      dual: !!(t & 0x800),
      tuner: !!(t & 0x1000),
      flip: !!(t & 0x200000),
      toon: !!(t & 0x400000),
      specialSummon: !!(t & 0x2000000),
      token: !!(t & 0x4000),
      // 以下为怪兽专属类型位；spell/trap 子类型复用同一高位，必须按 kind 分支，否则速攻魔法会被误判为灵摆
      synchro: monster && !!(t & 0x2000),
      pendulum: monster && !!(t & 0x1000000),
      xyz: monster && !!(t & 0x800000),
      link: monster && !!(t & 0x4000000)
    };
    if (kind === 'spell') {
      // 速攻/永续/装备/场地：0x10000/0x20000/0x40000/0x80000
      d.quickplay = !!(t & 0x10000);
      d.continuous = !!(t & 0x20000);
      d.equip = !!(t & 0x40000);
      d.field = !!(t & 0x80000);
    } else if (kind === 'trap') {
      d.counter = !!(t & 0x100000);
      d.continuous = !!(t & 0x20000);
    }
    return d;
  }

  function attrEntry(v) {
    for (const k in ATTR) if ((v >>> 0) & k) return ATTR[k];
    return { name: '?', en: '' };
  }
  function attrName(v) { return attrEntry(v).name; }

  function raceNames(mask) {
    const out = [];
    for (const k in RACE) if ((mask >>> 0) & k) out.push(RACE[k]);
    return out.join('/') || '?';
  }

  function frameClass(card) {
    const d = decodeType(card.type);
    if (d.kind === 'spell') return 'frame-spell';
    if (d.kind === 'trap') return 'frame-trap';
    if (d.link) return 'frame-link';
    if (d.xyz) return 'frame-xyz';
    if (d.pendulum) return 'frame-pendulum';
    if (d.synchro) return 'frame-synchro';
    if (d.fusion) return 'frame-fusion';
    if (d.ritual) return 'frame-ritual';
    if (d.normal) return 'frame-normal';
    return 'frame-effect';
  }

  function monsterLabel(d) {
    if (d.token) return '衍生物';
    if (d.link) return '连接怪兽';
    if (d.xyz) return 'XYZ怪兽';
    if (d.synchro) return '同步怪兽';
    if (d.fusion) return '融合怪兽';
    if (d.ritual) return '仪式怪兽';
    if (d.pendulum) return (d.effect ? '灵摆/效果怪兽' : '灵摆通常怪兽');
    if (d.normal) return '通常怪兽';
    if (d.effect) return '效果怪兽';
    return '怪兽';
  }

  function typeLabel(card) {
    const d = decodeType(card.type);
    if (d.kind === 'monster') return monsterLabel(d);
    if (d.kind === 'spell') {
      if (d.quickplay) return '速攻魔法';
      if (d.equip) return '装备魔法';
      if (d.field) return '场地魔法';
      if (d.continuous) return '永续魔法';
      if (d.ritual) return '仪式魔法';
      return '通常魔法';
    }
    if (d.counter) return '反击陷阱';
    if (d.continuous) return '永续陷阱';
    return '通常陷阱';
  }

  return { ATTR, RACE, LINK_MARKERS, decodeType, attrEntry, attrName, raceNames, frameClass, monsterLabel, typeLabel };
})();
