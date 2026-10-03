'use strict';

/**
 * 排演场地迁移：单文件备份 / 恢复。
 *
 * export（服务运行期间可执行）：在 SQLite 读事务内一次性导出全部业务表——
 * 草稿（灯具/回路/Cue/接线）、已发布版本快照、临时调光记录与操作序列、
 * 共享房间的控制状态（含控制密钥）、循环排演编排、讨论停点、定时启播预约与
 * 待领取的交接凭证——写成带 SHA-256 校验和的单个 JSON 文件。备份文件含
 * 密钥材料，落地权限固定为 0600（仅当前运行用户可读写）；命令输出只打印
 * 统计信息，不回显控制密钥或交接凭证。
 *
 * restore（服务停止后执行）：先完整校验备份（完整性校验和 → 结构兼容性 →
 * 引用关系），全部通过后才在空数据目录中原子落地（临时库 + 单事务写入 +
 * 同目录 rename）；目标目录已有数据库文件或任一校验失败都明确报错，且
 * 目标数据不变。版本编号、房间墙钟锚点、到点预约与交接凭证到期时刻全部
 * 按原值落库，恢复后由既有惰性推算逻辑按原绝对墙钟结算。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { SCHEMA } = require('./db');

const FORMAT = 'lighting-cue-backup';
const FORMAT_VERSION = 1;

class BackupError extends Error {}

function fail(message) {
  throw new BackupError(message);
}

/* ----------------------------- 表结构规格 ----------------------------- */
/* 与 src/db.js 的 SCHEMA 一一对应：列集合、类型、取值域、唯一性。
   恢复时据此做结构兼容性校验；库结构演进时同步提升 FORMAT_VERSION。
   列规则：t: 'int'（有限整数）/ 'num'（有限实数）/ 'str'（字符串）；
   nullable 允许 NULL；gt/gte/lte 为取值域；enum 限定取值集合。 */
const TABLE_SPECS = {
  circuits: {
    columns: {
      id: { t: 'int', gte: 1 },
      name: { t: 'str', nonEmpty: true },
      capacity: { t: 'num', gt: 0 },
      created_at: { t: 'num' },
    },
    unique: [['id'], ['name']],
    orderBy: 'id',
  },
  lights: {
    columns: {
      id: { t: 'int', gte: 1 },
      name: { t: 'str', nonEmpty: true },
      created_at: { t: 'num' },
      circuit_id: { t: 'int', gte: 1, nullable: true },
      watts: { t: 'num', gt: 0, nullable: true },
    },
    unique: [['id'], ['name']],
    orderBy: 'id',
  },
  cues: {
    columns: {
      id: { t: 'int', gte: 1 },
      cue_no: { t: 'int', gte: 1 },
      light_id: { t: 'int', gte: 1 },
      time: { t: 'num', gte: 0 },
      target: { t: 'num', gte: 0, lte: 100 },
      duration: { t: 'num', gte: 0 },
    },
    unique: [['id'], ['cue_no']],
    orderBy: 'id',
  },
  versions: {
    columns: {
      id: { t: 'int', gte: 1 },
      label: { t: 'str' },
      created_at: { t: 'num' },
      cue_count: { t: 'int', gte: 0 },
    },
    unique: [['id']],
    orderBy: 'id',
  },
  version_lights: {
    columns: {
      version_id: { t: 'int', gte: 1 },
      light_id: { t: 'int', gte: 1 },
      name: { t: 'str', nonEmpty: true },
      pos: { t: 'int', gte: 0 },
    },
    unique: [['version_id', 'light_id']],
    orderBy: 'version_id, pos',
  },
  version_cues: {
    columns: {
      version_id: { t: 'int', gte: 1 },
      cue_no: { t: 'int', gte: 1 },
      light_id: { t: 'int', gte: 1 },
      time: { t: 'num', gte: 0 },
      target: { t: 'num', gte: 0, lte: 100 },
      duration: { t: 'num', gte: 0 },
      pos: { t: 'int', gte: 0 },
    },
    unique: [['version_id', 'cue_no']],
    orderBy: 'version_id, pos',
  },
  version_circuits: {
    columns: {
      version_id: { t: 'int', gte: 1 },
      circuit_id: { t: 'int', gte: 1 },
      name: { t: 'str', nonEmpty: true },
      capacity: { t: 'num', gt: 0 },
      pos: { t: 'int', gte: 0 },
    },
    unique: [['version_id', 'circuit_id']],
    orderBy: 'version_id, pos',
  },
  version_light_wiring: {
    columns: {
      version_id: { t: 'int', gte: 1 },
      light_id: { t: 'int', gte: 1 },
      circuit_id: { t: 'int', gte: 1, nullable: true },
      watts: { t: 'num', gt: 0, nullable: true },
    },
    unique: [['version_id', 'light_id']],
    orderBy: 'version_id, light_id',
  },
  rehearsal_records: {
    columns: {
      id: { t: 'int', gte: 1 },
      version_id: { t: 'int', gte: 1 },
      label: { t: 'str' },
      created_at: { t: 'num' },
      revision: { t: 'int', gte: 0 },
    },
    unique: [['id']],
    orderBy: 'id',
  },
  record_ops: {
    columns: {
      id: { t: 'int', gte: 1 },
      record_id: { t: 'int', gte: 1 },
      seq: { t: 'int', gte: 1 },
      light_id: { t: 'int', gte: 1 },
      time: { t: 'num', gte: 0 },
      op_type: { t: 'str', enum: ['override', 'return'] },
      target: { t: 'num', gte: 0, lte: 100, nullable: true },
      duration: { t: 'num', gte: 0 },
    },
    unique: [['id'], ['record_id', 'seq']],
    orderBy: 'id',
  },
  rooms: {
    columns: {
      id: { t: 'int', gte: 1 },
      code: { t: 'str', nonEmpty: true },
      version_id: { t: 'int', gte: 1 },
      control_key: { t: 'str', nonEmpty: true },
      label: { t: 'str' },
      playing: { t: 'int', enum: [0, 1] },
      time: { t: 'num', gte: 0 },
      anchor_wall: { t: 'num' },
      speed: { t: 'num', enum: [0.5, 1, 2] },
      duration: { t: 'num', gte: 0 },
      revision: { t: 'int', gte: 0 },
      overload_protection: { t: 'int', enum: [0, 1] },
      tripped_circuit_id: { t: 'int', gte: 1, nullable: true },
      tripped_time: { t: 'num', nullable: true },
      stopped_time: { t: 'num', nullable: true },
      scheduled_start_at: { t: 'num', nullable: true },
      created_at: { t: 'num' },
    },
    unique: [['id'], ['code']],
    orderBy: 'id',
  },
  room_handovers: {
    columns: {
      room_id: { t: 'int', gte: 1 },
      token: { t: 'str', nonEmpty: true },
      revision: { t: 'int', gte: 0 },
      expires_at: { t: 'num' },
      created_at: { t: 'num' },
    },
    unique: [['room_id']],
    orderBy: 'room_id',
  },
  room_programs: {
    columns: {
      room_id: { t: 'int', gte: 1 },
      segments: { t: 'str', nonEmpty: true },
      seg_index: { t: 'int', gte: 0 },
      iteration: { t: 'int', gte: 0 },
      prog_time: { t: 'num', gte: 0 },
      finished: { t: 'int', enum: [0, 1] },
    },
    unique: [['room_id']],
    orderBy: 'room_id',
  },
  room_stops: {
    columns: {
      room_id: { t: 'int', gte: 1 },
      stops: { t: 'str' },
    },
    unique: [['room_id']],
    orderBy: 'room_id',
  },
  room_schedules: {
    columns: {
      room_id: { t: 'int', gte: 1 },
      start_at: { t: 'num' },
    },
    unique: [['room_id']],
    orderBy: 'room_id',
  },
};

// 导出顺序 = 恢复写入顺序（被引用的父表在前）
const TABLE_ORDER = [
  'circuits',
  'lights',
  'cues',
  'versions',
  'version_lights',
  'version_cues',
  'version_circuits',
  'version_light_wiring',
  'rehearsal_records',
  'record_ops',
  'rooms',
  'room_handovers',
  'room_programs',
  'room_stops',
  'room_schedules',
];

// 单列引用关系：[表, 列, 被引用表, 被引用列, 中文名]
const SIMPLE_REFS = [
  ['cues', 'light_id', 'lights', 'id', '灯具'],
  ['lights', 'circuit_id', 'circuits', 'id', '回路'],
  ['version_lights', 'version_id', 'versions', 'id', '版本'],
  ['version_cues', 'version_id', 'versions', 'id', '版本'],
  ['version_circuits', 'version_id', 'versions', 'id', '版本'],
  ['version_light_wiring', 'version_id', 'versions', 'id', '版本'],
  ['rehearsal_records', 'version_id', 'versions', 'id', '版本'],
  ['record_ops', 'record_id', 'rehearsal_records', 'id', '调光记录'],
  ['rooms', 'version_id', 'versions', 'id', '版本'],
  ['room_handovers', 'room_id', 'rooms', 'id', '房间'],
  ['room_programs', 'room_id', 'rooms', 'id', '房间'],
  ['room_stops', 'room_id', 'rooms', 'id', '房间'],
  ['room_schedules', 'room_id', 'rooms', 'id', '房间'],
];

// 错误信息中不显示取值的敏感列（控制密钥 / 交接凭证）
const SENSITIVE_COLUMNS = new Set(['control_key', 'token']);

function showValue(col, v) {
  if (SENSITIVE_COLUMNS.has(col)) return '（值不显示）';
  return JSON.stringify(v);
}

function typeName(v) {
  if (v === null) return 'NULL';
  if (Array.isArray(v)) return '数组';
  return typeof v;
}

/* ----------------------------- 工具函数 ----------------------------- */

function computeChecksum(signed) {
  const digest = crypto.createHash('sha256').update(JSON.stringify(signed), 'utf8').digest('hex');
  return `sha256:${digest}`;
}

function countRows(tables) {
  const counts = {};
  for (const name of TABLE_ORDER) counts[name] = tables[name].length;
  return counts;
}

function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* 某些文件系统不支持目录 fsync，忽略 */
  }
}

// 原子写文件：同目录临时文件 + fsync + rename，权限固定（备份含密钥材料）
function writeFileAtomic(target, content, mode) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
    fs.chmodSync(target, mode);
    fsyncDir(path.dirname(target));
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件不存在则忽略 */
    }
    throw e;
  }
}

/* ------------------------------- 导出 ------------------------------- */

/**
 * 导出一致的单文件备份（服务运行期间可执行）。
 * @param {string} dbPath SQLite 数据库路径
 * @param {string} outputPath 目标备份文件路径
 * @param {{force?: boolean}} [opts] force=true 允许覆盖已存在的备份文件
 * @returns {{path: string, counts: Object}} 备份文件绝对路径与各表行数
 */
function exportBackup(dbPath, outputPath, { force = false } = {}) {
  if (!fs.existsSync(dbPath)) {
    fail(`数据库文件不存在：${dbPath}（请检查 --db 路径；服务尚未产生数据时无可备份）`);
  }
  const outAbs = path.resolve(outputPath);
  if (fs.existsSync(outAbs) && !force) {
    fail(`目标备份文件已存在：${outAbs}（如需覆盖请加 --force）`);
  }

  const db = new Database(dbPath, { fileMustExist: true });
  let tables;
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('query_only = ON');
    const existing = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    );
    for (const name of TABLE_ORDER) {
      if (!existing.has(name)) {
        fail(`数据库缺少表 ${name}：请先启动一次当前版本的服务完成库结构初始化，再执行备份`);
      }
    }
    tables = {};
    // 单读事务导出：WAL 下读写互不阻塞，服务运行期间也能得到一致快照
    db.exec('BEGIN');
    try {
      for (const name of TABLE_ORDER) {
        tables[name] = db.prepare(`SELECT * FROM ${name} ORDER BY ${TABLE_SPECS[name].orderBy}`).all();
      }
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 连接关闭时事务随连接回收 */
      }
      throw e;
    }
  } finally {
    db.close();
  }

  const signed = { format: FORMAT, format_version: FORMAT_VERSION, created_at: Date.now() / 1000, tables };
  const fileObj = { ...signed, checksum: computeChecksum(signed) };
  writeFileAtomic(outAbs, JSON.stringify(fileObj), 0o600);
  return { path: outAbs, counts: countRows(tables) };
}

/* --------------------------- 校验（恢复前置） --------------------------- */

function checkValue(table, rowNo, col, rule, v) {
  const where = `表 ${table} 第 ${rowNo} 行列 ${col}`;
  if (v === null) {
    if (rule.nullable) return;
    fail(`备份结构校验失败：${where} 不允许为 NULL`);
  }
  if (rule.t === 'str') {
    if (typeof v !== 'string') {
      fail(`备份结构校验失败：${where} 应为字符串，实际为 ${typeName(v)}`);
    }
    if (rule.nonEmpty && v.length === 0) {
      fail(`备份结构校验失败：${where} 不能为空字符串`);
    }
    if (rule.enum && !rule.enum.includes(v)) {
      fail(`备份结构校验失败：${where} 取值 ${showValue(col, v)} 不在允许范围（${rule.enum.join(' / ')}）`);
    }
    return;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    fail(`备份结构校验失败：${where} 应为有限数字，实际为 ${typeName(v)}`);
  }
  if (rule.t === 'int' && !Number.isInteger(v)) {
    fail(`备份结构校验失败：${where} 应为整数，实际为 ${showValue(col, v)}`);
  }
  if (rule.enum && !rule.enum.includes(v)) {
    fail(`备份结构校验失败：${where} 取值 ${showValue(col, v)} 不在允许范围（${rule.enum.join(' / ')}）`);
  }
  if (rule.gt !== undefined && !(v > rule.gt)) {
    fail(`备份结构校验失败：${where} 须大于 ${rule.gt}，实际为 ${showValue(col, v)}`);
  }
  if (rule.gte !== undefined && !(v >= rule.gte)) {
    fail(`备份结构校验失败：${where} 须不小于 ${rule.gte}，实际为 ${showValue(col, v)}`);
  }
  if (rule.lte !== undefined && !(v <= rule.lte)) {
    fail(`备份结构校验失败：${where} 须不大于 ${rule.lte}，实际为 ${showValue(col, v)}`);
  }
}

// JSON 文本列：编排段与讨论停点，须能解析且形状合法
function validateJsonColumns(tables) {
  tables.room_programs.forEach((row, i) => {
    const where = `表 room_programs 第 ${i + 1} 行 segments`;
    let segs;
    try {
      segs = JSON.parse(row.segments);
    } catch {
      fail(`备份结构校验失败：${where} 不是合法 JSON`);
    }
    if (!Array.isArray(segs) || segs.length < 1 || segs.length > 8) {
      fail(`备份结构校验失败：${where} 须为 1～8 段的数组`);
    }
    segs.forEach((s, j) => {
      const segWhere = `${where} 第 ${j + 1} 段`;
      if (!s || typeof s !== 'object' || Array.isArray(s)) {
        fail(`备份结构校验失败：${segWhere} 不是对象`);
      }
      if (typeof s.start !== 'number' || !Number.isFinite(s.start) || s.start < 0) {
        fail(`备份结构校验失败：${segWhere} 起点非法（须为非负时码）`);
      }
      if (typeof s.end !== 'number' || !Number.isFinite(s.end) || !(s.end > s.start)) {
        fail(`备份结构校验失败：${segWhere} 终点非法（须严格大于起点）`);
      }
      if (!Number.isInteger(s.repeat) || s.repeat < 1) {
        fail(`备份结构校验失败：${segWhere} 重复次数非法（须为正整数）`);
      }
    });
  });
  tables.room_stops.forEach((row, i) => {
    const where = `表 room_stops 第 ${i + 1} 行 stops`;
    let stops;
    try {
      stops = JSON.parse(row.stops);
    } catch {
      fail(`备份结构校验失败：${where} 不是合法 JSON`);
    }
    if (!Array.isArray(stops)) {
      fail(`备份结构校验失败：${where} 须为时码数组`);
    }
    const seen = new Set();
    stops.forEach((t) => {
      if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) {
        fail(`备份结构校验失败：${where} 含非法停点时码（须为非负数字）`);
      }
      if (seen.has(t)) {
        fail(`备份结构校验失败：${where} 含重复停点时码 ${t}`);
      }
      seen.add(t);
    });
  });
}

function validateStructure(tables) {
  if (!tables || typeof tables !== 'object' || Array.isArray(tables)) {
    fail('备份结构校验失败：缺少 tables 数据');
  }
  for (const name of Object.keys(tables)) {
    if (!TABLE_SPECS[name]) {
      fail(`备份结构校验失败：含有本版本不认识的表 ${name}`);
    }
  }
  for (const [name, spec] of Object.entries(TABLE_SPECS)) {
    const rows = tables[name];
    if (!Array.isArray(rows)) {
      fail(`备份结构校验失败：缺少表 ${name}（或它不是行数组）`);
    }
    const cols = Object.keys(spec.columns);
    rows.forEach((row, i) => {
      const rowNo = i + 1;
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        fail(`备份结构校验失败：表 ${name} 第 ${rowNo} 行不是对象`);
      }
      const missing = cols.filter((c) => !(c in row));
      const extra = Object.keys(row).filter((c) => !spec.columns[c]);
      if (missing.length || extra.length) {
        const parts = [];
        if (missing.length) parts.push(`缺少列 ${missing.join(', ')}`);
        if (extra.length) parts.push(`含未知列 ${extra.join(', ')}`);
        fail(`备份结构校验失败：表 ${name} 第 ${rowNo} 行${parts.join('，')}`);
      }
      for (const [col, rule] of Object.entries(spec.columns)) {
        checkValue(name, rowNo, col, rule, row[col]);
      }
    });
    for (const uk of spec.unique || []) {
      const seen = new Map();
      rows.forEach((row, i) => {
        const key = JSON.stringify(uk.map((c) => row[c]));
        if (seen.has(key)) {
          fail(`备份结构校验失败：表 ${name} 第 ${seen.get(key)} 行与第 ${i + 1} 行的（${uk.join(', ')}）重复`);
        }
        seen.set(key, i + 1);
      });
    }
  }
  validateJsonColumns(tables);
}

function validateReferences(tables) {
  for (const [table, col, refTable, refCol, label] of SIMPLE_REFS) {
    const ids = new Set(tables[refTable].map((r) => r[refCol]));
    tables[table].forEach((row, i) => {
      const v = row[col];
      if (v === null) return; // 可空列（是否允许 NULL 已由结构校验限定）
      if (!ids.has(v)) {
        fail(`备份引用关系校验失败：表 ${table} 第 ${i + 1} 行引用了不存在的${label}（${refTable}.${refCol} = ${v}）`);
      }
    });
  }
  // 版本快照内部的组合引用：Cue/接线引用的灯具、接线引用的回路须在同一版本快照中
  const vLights = new Set(tables.version_lights.map((r) => `${r.version_id}/${r.light_id}`));
  tables.version_cues.forEach((row, i) => {
    if (!vLights.has(`${row.version_id}/${row.light_id}`)) {
      fail(`备份引用关系校验失败：表 version_cues 第 ${i + 1} 行引用的灯具 #${row.light_id} 不在版本 #${row.version_id} 的灯具快照中`);
    }
  });
  const vCircuits = new Set(tables.version_circuits.map((r) => `${r.version_id}/${r.circuit_id}`));
  tables.version_light_wiring.forEach((row, i) => {
    if (!vLights.has(`${row.version_id}/${row.light_id}`)) {
      fail(`备份引用关系校验失败：表 version_light_wiring 第 ${i + 1} 行引用的灯具 #${row.light_id} 不在版本 #${row.version_id} 的灯具快照中`);
    }
    if (row.circuit_id !== null && !vCircuits.has(`${row.version_id}/${row.circuit_id}`)) {
      fail(`备份引用关系校验失败：表 version_light_wiring 第 ${i + 1} 行引用的回路 #${row.circuit_id} 不在版本 #${row.version_id} 的回路快照中`);
    }
  });
}

// 跨表一致性：冗余计数、绑定快照内的引用、触发落库引用
function validateConsistency(tables) {
  const cueCount = new Map();
  for (const r of tables.version_cues) cueCount.set(r.version_id, (cueCount.get(r.version_id) || 0) + 1);
  tables.versions.forEach((v) => {
    const n = cueCount.get(v.id) || 0;
    if (v.cue_count !== n) {
      fail(`备份引用关系校验失败：版本 #${v.id} 的 cue_count=${v.cue_count} 与快照内 Cue 数 ${n} 不一致`);
    }
  });
  const recVersion = new Map(tables.rehearsal_records.map((r) => [r.id, r.version_id]));
  const vLights = new Set(tables.version_lights.map((r) => `${r.version_id}/${r.light_id}`));
  tables.record_ops.forEach((op, i) => {
    const vid = recVersion.get(op.record_id);
    if (vid !== undefined && !vLights.has(`${vid}/${op.light_id}`)) {
      fail(`备份引用关系校验失败：表 record_ops 第 ${i + 1} 行引用的灯具 #${op.light_id} 不在记录 #${op.record_id} 绑定的版本快照中`);
    }
  });
  const vCircuits = new Set(tables.version_circuits.map((r) => `${r.version_id}/${r.circuit_id}`));
  tables.rooms.forEach((room, i) => {
    if (room.tripped_circuit_id !== null && !vCircuits.has(`${room.version_id}/${room.tripped_circuit_id}`)) {
      fail(`备份引用关系校验失败：表 rooms 第 ${i + 1} 行的触发回路 #${room.tripped_circuit_id} 不在房间固定版本 #${room.version_id} 的回路快照中`);
    }
  });
}

/**
 * 读取并完整校验备份文件：完整性（校验和）→ 结构兼容性 → 引用关系。
 * 通过则返回 { created_at, tables }，否则抛出 BackupError。
 */
function loadAndValidateBackup(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    fail(`备份文件不可读：${file}（文件不存在或没有读取权限）`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    fail('备份完整性校验失败：文件不是合法 JSON（已损坏或被截断）');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    fail('备份完整性校验失败：文件内容不是备份对象');
  }
  if (obj.format !== FORMAT) {
    fail(`备份结构校验失败：format=${JSON.stringify(obj.format)}，不是本应用（${FORMAT}）的备份文件`);
  }
  if (obj.format_version !== FORMAT_VERSION) {
    fail(`备份结构校验失败：备份格式版本 ${JSON.stringify(obj.format_version)} 与当前支持的版本 ${FORMAT_VERSION} 不兼容`);
  }
  if (typeof obj.checksum !== 'string') {
    fail('备份完整性校验失败：缺少校验和');
  }
  const signed = {
    format: obj.format,
    format_version: obj.format_version,
    created_at: obj.created_at,
    tables: obj.tables,
  };
  const expect = computeChecksum(signed);
  const a = Buffer.from(obj.checksum);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    fail('备份完整性校验失败：校验和不匹配，文件已损坏或被篡改');
  }
  validateStructure(obj.tables);
  validateReferences(obj.tables);
  validateConsistency(obj.tables);
  return { created_at: obj.created_at, tables: obj.tables };
}

/* ------------------------------- 恢复 ------------------------------- */

function insertRows(db, name, rows) {
  if (!rows.length) return;
  const cols = Object.keys(TABLE_SPECS[name].columns);
  const stmt = db.prepare(`INSERT INTO ${name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  for (const row of rows) {
    stmt.run(cols.map((c) => (row[c] === undefined ? null : row[c])));
  }
}

function restoreBackupInner(file, dbPath) {
  // 先校验：完整性、结构兼容性、引用关系全部通过前不触碰目标目录
  const { tables } = loadAndValidateBackup(file);

  const dbAbs = path.resolve(dbPath);
  const dir = path.dirname(dbAbs);
  fs.mkdirSync(dir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    if (fs.existsSync(dbAbs + suffix)) {
      fail(`目标数据目录非空：已存在数据库文件 ${dbAbs}${suffix}；恢复要求停服后的空数据目录`);
    }
  }

  // 原子落地：同目录临时库 + 单事务写入 + rename；失败则清理临时文件，目标不变
  const tmp = `${dbAbs}.restore-${process.pid}.tmp`;
  try {
    const db = new Database(tmp);
    try {
      db.pragma('journal_mode = DELETE');
      db.pragma('synchronous = FULL');
      db.pragma('foreign_keys = ON');
      db.exec(SCHEMA);
      const insertAll = db.transaction(() => {
        for (const name of TABLE_ORDER) insertRows(db, name, tables[name]);
      });
      insertAll();
      const fk = db.prepare('PRAGMA foreign_key_check').all();
      if (fk.length > 0) {
        fail(`备份引用关系校验失败：SQLite 外键检查未通过（${fk[0].table} 等 ${fk.length} 处）`);
      }
      const ic = db.prepare('PRAGMA integrity_check').get();
      if (!ic || ic.integrity_check !== 'ok') {
        fail('备份落地后完整性检查未通过');
      }
    } finally {
      db.close();
    }
    fs.chmodSync(tmp, 0o600);
    const fd = fs.openSync(tmp, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, dbAbs); // 同目录 rename：原子生效
    fsyncDir(dir);
  } catch (e) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try {
        fs.unlinkSync(tmp + suffix);
      } catch {
        /* 临时文件不存在则忽略 */
      }
    }
    throw e;
  }
  return { path: dbAbs, counts: countRows(tables) };
}

/**
 * 恢复备份到空数据目录（服务须已停止）。
 * @param {string} file 备份文件路径
 * @param {string} dbPath 目标 SQLite 数据库路径（其所在目录不得已有数据库文件）
 * @returns {{path: string, counts: Object}}
 */
function restoreBackup(file, dbPath) {
  try {
    return restoreBackupInner(file, dbPath);
  } catch (e) {
    if (e instanceof BackupError && !/目标数据未改动/.test(e.message)) {
      throw new BackupError(`${e.message}（恢复未执行，目标数据未改动）`);
    }
    throw e;
  }
}

/* ------------------------------- CLI ------------------------------- */

const USAGE = `排演场地迁移：单文件备份 / 恢复

用法：
  node src/backup.js export  --output <备份文件> [--db <SQLite路径>] [--force]
  node src/backup.js restore --file <备份文件>   [--db <SQLite路径>]

说明：
  export   服务运行期间也可执行：在数据库读事务内导出一致快照，写成带校验和的
           单文件备份（草稿、已发布版本快照、临时调光记录、共享房间的控制/
           编排/停点/预约与待领取交接凭证）。备份文件权限固定为 600（仅当前
           用户可读写）；文件内含控制密钥与交接凭证，请妥善保管。
  restore  服务停止后执行：先校验备份完整性、结构兼容性与引用关系，全部通过
           后在空数据目录原子落地；目标目录已有数据库文件或校验失败都会明确
           报错，且目标数据不变。恢复后版本编号保持不变，房间播放进度、到点
           预约与交接凭证到期时刻均按原绝对墙钟结算。
  --db     SQLite 数据库路径，默认取环境变量 DB_PATH，否则 ./data/app.db
  --force  export 专用：允许覆盖已存在的备份文件
`;

function defaultDbPath() {
  return process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
}

function parseArgs(argv) {
  const opts = {};
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') {
      flags.add('force');
      continue;
    }
    const m = a.match(/^--([a-z]+)(?:=(.*))?$/);
    if (!m) fail(`无法识别的参数：${a}`);
    const [, key, inline] = m;
    if (inline !== undefined) {
      opts[key] = inline;
      continue;
    }
    if (i + 1 >= argv.length) fail(`参数 --${key} 缺少取值`);
    opts[key] = argv[++i];
  }
  return { opts, flags };
}

function main(argv) {
  const cmd = argv[0];
  if (cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return;
  }
  if (cmd !== 'export' && cmd !== 'restore') {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const { opts, flags } = parseArgs(argv.slice(1));
  const dbPath = path.resolve(opts.db || defaultDbPath());
  if (cmd === 'export') {
    if (!opts.output) fail('缺少参数 --output <备份文件>');
    const r = exportBackup(dbPath, opts.output, { force: flags.has('force') });
    const c = r.counts;
    console.log(`备份完成：${r.path}`);
    console.log(`  草稿：灯具 ${c.lights} 盏、回路 ${c.circuits} 条、Cue ${c.cues} 条`);
    console.log(`  已发布版本 ${c.versions} 个（含完整快照）；临时调光记录 ${c.rehearsal_records} 条（操作 ${c.record_ops} 条）`);
    console.log(
      `  共享房间 ${c.rooms} 个（编排 ${c.room_programs}、停点 ${c.room_stops}、预约 ${c.room_schedules}、待领取交接凭证 ${c.room_handovers}）`
    );
    console.log('  文件权限 600（仅当前用户可读写）；备份内含控制密钥与交接凭证，请妥善保管');
  } else {
    if (!opts.file) fail('缺少参数 --file <备份文件>');
    const r = restoreBackup(opts.file, dbPath);
    const c = r.counts;
    console.log(`恢复完成：${r.path}`);
    console.log(
      `  版本 ${c.versions} 个（编号与快照保持原样）、调光记录 ${c.rehearsal_records} 条、共享房间 ${c.rooms} 个（编排/停点/预约/交接状态一并恢复）`
    );
    console.log('  房间播放进度、到点预约与交接凭证到期时刻均按原绝对墙钟结算');
    console.log('  现在可按原方式启动服务（npm start 或 docker compose up -d），既有 HTTP API 即可使用');
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`错误：${e.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  exportBackup,
  restoreBackup,
  loadAndValidateBackup,
  computeChecksum,
  BackupError,
  FORMAT,
  FORMAT_VERSION,
};
