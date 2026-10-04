'use strict';

/**
 * 排演场地迁移用的单文件备份 / 恢复工具（CLI）。
 *
 * 备份：node src/backup.js backup <输出文件> [--db 数据库路径]
 *   - 可在服务运行期间执行：通过 SQLite 在线备份（Online Backup）API 取得
 *     事务一致的整库快照（草稿、已发布版本快照、临时调光记录、共享房间的
 *     控制状态 / 循环编排 / 讨论停点 / 定时启播预约 / 主持权交接凭证全部在内）。
 *   - 快照封入单文件容器：魔数 + 清单（表行数、应用版本、生成时刻、载荷 SHA-256）
 *     + 数据库载荷。输出文件权限固定 0600（仅当前运行用户可读），同目录临时文件 +
 *     rename 原子替换；任何输出都不包含控制密钥或交接凭证本体。
 *
 * 恢复：node src/backup.js restore <备份文件> <空数据目录>
 *   - 要求服务已停、目标目录存在且为空；先做【校验和 → 完整性 → 结构兼容性 →
 *     引用关系】全部校验，再 fsync + rename 原子落地为目录下的 app.db。
 *   - 目标非空或任一校验失败：明确报错且目标目录保持原样（不留下任何文件）。
 *   - 版本快照编号、房间基准墙钟、预约绝对启播时刻、交接凭证到期时刻全部按
 *     备份中原值恢复（不做任何时间平移）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const APP_VERSION = require('../package.json').version;

const MAGIC = Buffer.from('CRBK', 'ascii'); // Cue Rehearsal BacKup
const FORMAT_VERSION = 1;
const DB_FILENAME = 'app.db';

// 本应用全部业务表（备份清单逐表统计；恢复时必须齐备）
const TABLES = [
  'lights',
  'cues',
  'circuits',
  'versions',
  'version_lights',
  'version_cues',
  'version_circuits',
  'version_light_wiring',
  'rehearsal_records',
  'record_ops',
  'merge_previews',
  'rooms',
  'room_handovers',
  'room_programs',
  'room_stops',
  'room_schedules',
];

// 结构兼容性：每张表至少必须包含的列（允许恢复更早/更晚的小版本，只要关键列齐备）
const REQUIRED_COLUMNS = {
  lights: ['id', 'name', 'created_at', 'circuit_id', 'watts'],
  cues: ['id', 'cue_no', 'light_id', 'time', 'target', 'duration'],
  circuits: ['id', 'name', 'capacity', 'created_at'],
  versions: ['id', 'label', 'created_at', 'cue_count'],
  version_lights: ['version_id', 'light_id', 'name', 'pos'],
  version_cues: ['version_id', 'cue_no', 'light_id', 'time', 'target', 'duration', 'pos'],
  version_circuits: ['version_id', 'circuit_id', 'name', 'capacity', 'pos'],
  version_light_wiring: ['version_id', 'light_id', 'circuit_id', 'watts'],
  rehearsal_records: ['id', 'version_id', 'label', 'created_at', 'revision'],
  record_ops: ['id', 'record_id', 'seq', 'light_id', 'time', 'op_type', 'target', 'duration'],
  merge_previews: ['token', 'base_id', 'incoming_id', 'draft_stamp', 'payload', 'created_at'],
  rooms: [
    'id', 'code', 'version_id', 'control_key', 'label', 'playing', 'time',
    'anchor_wall', 'speed', 'duration', 'revision', 'overload_protection',
    'tripped_circuit_id', 'tripped_time', 'stopped_time', 'scheduled_start_at', 'created_at',
  ],
  room_handovers: ['room_id', 'token', 'revision', 'expires_at', 'created_at'],
  room_programs: ['room_id', 'segments', 'seg_index', 'iteration', 'prog_time', 'finished'],
  room_stops: ['room_id', 'stops'],
  room_schedules: ['room_id', 'start_at'],
};

// 引用关系校验（SQLite 外键之外、快照逻辑内的引用同样核对）。
// 每条返回孤儿行即记一条引用异常。
const REFERENCE_CHECKS = [
  {
    name: '版本灯具快照指向不存在的版本',
    sql: `SELECT COUNT(*) AS n FROM version_lights vl
          LEFT JOIN versions v ON v.id = vl.version_id WHERE v.id IS NULL`,
  },
  {
    name: '版本 Cue 快照指向不存在的版本',
    sql: `SELECT COUNT(*) AS n FROM version_cues vc
          LEFT JOIN versions v ON v.id = vc.version_id WHERE v.id IS NULL`,
  },
  {
    name: '版本回路快照指向不存在的版本',
    sql: `SELECT COUNT(*) AS n FROM version_circuits vc
          LEFT JOIN versions v ON v.id = vc.version_id WHERE v.id IS NULL`,
  },
  {
    name: '版本接线快照指向不存在的版本',
    sql: `SELECT COUNT(*) AS n FROM version_light_wiring vw
          LEFT JOIN versions v ON v.id = vw.version_id WHERE v.id IS NULL`,
  },
  {
    name: '版本 Cue 快照引用的灯具不在同版本灯具快照中',
    sql: `SELECT COUNT(*) AS n FROM version_cues vc
          LEFT JOIN version_lights vl
            ON vl.version_id = vc.version_id AND vl.light_id = vc.light_id
          WHERE vl.light_id IS NULL`,
  },
  {
    name: '版本接线快照引用的灯具不在同版本灯具快照中',
    sql: `SELECT COUNT(*) AS n FROM version_light_wiring vw
          LEFT JOIN version_lights vl
            ON vl.version_id = vw.version_id AND vl.light_id = vw.light_id
          WHERE vl.light_id IS NULL`,
  },
  {
    name: '版本接线快照引用的回路不在同版本回路快照中',
    sql: `SELECT COUNT(*) AS n FROM version_light_wiring vw
          LEFT JOIN version_circuits vc
            ON vc.version_id = vw.version_id AND vc.circuit_id = vw.circuit_id
          WHERE vw.circuit_id IS NOT NULL AND vc.circuit_id IS NULL`,
  },
  {
    name: '调光记录指向不存在的版本',
    sql: `SELECT COUNT(*) AS n FROM rehearsal_records r
          LEFT JOIN versions v ON v.id = r.version_id WHERE v.id IS NULL`,
  },
  {
    name: '调光操作指向不存在的记录',
    sql: `SELECT COUNT(*) AS n FROM record_ops o
          LEFT JOIN rehearsal_records r ON r.id = o.record_id WHERE r.id IS NULL`,
  },
  {
    name: '调光操作引用的灯具不在记录绑定版本的灯具快照中',
    sql: `SELECT COUNT(*) AS n FROM record_ops o
          JOIN rehearsal_records r ON r.id = o.record_id
          LEFT JOIN version_lights vl
            ON vl.version_id = r.version_id AND vl.light_id = o.light_id
          WHERE vl.light_id IS NULL`,
  },
  {
    name: '共享房间指向不存在的版本',
    sql: `SELECT COUNT(*) AS n FROM rooms rm
          LEFT JOIN versions v ON v.id = rm.version_id WHERE v.id IS NULL`,
  },
  {
    name: '房间固化的超载触发回路不在其固定版本快照中',
    sql: `SELECT COUNT(*) AS n FROM rooms rm
          LEFT JOIN version_circuits vc
            ON vc.version_id = rm.version_id AND vc.circuit_id = rm.tripped_circuit_id
          WHERE rm.tripped_circuit_id IS NOT NULL AND vc.circuit_id IS NULL`,
  },
  {
    name: '主持权交接凭证指向不存在的房间',
    sql: `SELECT COUNT(*) AS n FROM room_handovers h
          LEFT JOIN rooms rm ON rm.id = h.room_id WHERE rm.id IS NULL`,
  },
  {
    name: '循环排演编排指向不存在的房间',
    sql: `SELECT COUNT(*) AS n FROM room_programs p
          LEFT JOIN rooms rm ON rm.id = p.room_id WHERE rm.id IS NULL`,
  },
  {
    name: '讨论停点指向不存在的房间',
    sql: `SELECT COUNT(*) AS n FROM room_stops s
          LEFT JOIN rooms rm ON rm.id = s.room_id WHERE rm.id IS NULL`,
  },
  {
    name: '定时启播预约指向不存在的房间',
    sql: `SELECT COUNT(*) AS n FROM room_schedules sc
          LEFT JOIN rooms rm ON rm.id = sc.room_id WHERE rm.id IS NULL`,
  },
  {
    name: '合并预览令牌指向不存在的基线版本',
    sql: `SELECT COUNT(*) AS n FROM merge_previews mp
          LEFT JOIN versions v ON v.id = mp.base_id WHERE v.id IS NULL`,
  },
  {
    name: '合并预览令牌指向不存在的待合入版本',
    sql: `SELECT COUNT(*) AS n FROM merge_previews mp
          LEFT JOIN versions v ON v.id = mp.incoming_id WHERE v.id IS NULL`,
  },
];

// 取值域校验：违反 CHECK/业务取值域的行数必须为 0
const DOMAIN_CHECKS = [
  {
    name: '草稿 Cue 存在非法时码/亮度/渐变时长',
    sql: `SELECT COUNT(*) AS n FROM cues
          WHERE time < 0 OR target < 0 OR target > 100 OR duration < 0`,
  },
  {
    name: '版本 Cue 快照存在非法时码/亮度/渐变时长',
    sql: `SELECT COUNT(*) AS n FROM version_cues
          WHERE time < 0 OR target < 0 OR target > 100 OR duration < 0`,
  },
  {
    name: '调光操作存在非法类型/时码/渐变时长',
    sql: `SELECT COUNT(*) AS n FROM record_ops
          WHERE op_type NOT IN ('override', 'return') OR time < 0 OR duration < 0
             OR (op_type = 'return' AND target IS NOT NULL)
             OR (op_type = 'override' AND (target IS NULL OR target < 0 OR target > 100))`,
  },
  {
    name: '房间倍速不是 0.5/1/2，或播放标志/保护标志非法',
    sql: `SELECT COUNT(*) AS n FROM rooms
          WHERE speed NOT IN (0.5, 1, 2) OR playing NOT IN (0, 1)
             OR overload_protection NOT IN (0, 1) OR time < 0 OR duration < 0
             OR revision < 0`,
  },
];

class BackupError extends Error {}

function defaultDbPath() {
  return process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
}

function fsyncFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 通过 SQLite 在线备份 API 把（可能正被服务进程写的）源库一致快照到目标文件。
 * 备份读取的是某一时刻的事务一致视图，服务期间的读写不受影响。
 */
function liveSnapshot(srcPath, destPath) {
  const src = new Database(srcPath);
  return src.backup(destPath).finally(() => src.close());
}

function countTables(db) {
  const counts = {};
  for (const t of TABLES) {
    counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
  }
  return counts;
}

function summarizeCounts(c) {
  return (
    `草稿：灯具 ${c.lights}、回路 ${c.circuits}、草稿 Cue ${c.cues}；` +
    `已发布版本 ${c.versions}（快照灯具 ${c.version_lights}、快照 Cue ${c.version_cues}、` +
    `快照回路 ${c.version_circuits}、快照接线 ${c.version_light_wiring}）；` +
    `临时调光记录 ${c.rehearsal_records}（操作 ${c.record_ops}）；` +
    `共享房间 ${c.rooms}（循环编排 ${c.room_programs}、停点 ${c.room_stops}、` +
    `定时启播预约 ${c.room_schedules}、待领取交接凭证 ${c.room_handovers}）`
  );
}

/**
 * 备份：读取运行中的数据库 → 一致性快照 → 封装单文件（0600、原子替换）。
 */
async function backup(dbPath, outPath) {
  if (!fs.existsSync(dbPath)) {
    throw new BackupError(`数据库文件不存在：${dbPath}（请确认服务是否已初始化，或用 --db 指定数据库路径）`);
  }

  const outDir = path.dirname(path.resolve(outPath));
  fs.mkdirSync(outDir, { recursive: true });

  // 1) 在线备份到系统临时文件（与目标目录无关，失败不污染目标）
  const tmpSnapshot = path.join(
    os.tmpdir(),
    `crbk-snapshot-${process.pid}-${crypto.randomBytes(6).toString('hex')}.db`
  );
  let counts;
  const createdAt = Date.now() / 1000;
  try {
    await liveSnapshot(dbPath, tmpSnapshot);
    const snap = new Database(tmpSnapshot, { readonly: true });
    try {
      const integrity = snap.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]);
      if (integrity.length !== 1 || integrity[0] !== 'ok') {
        throw new BackupError(`源数据库完整性检查未通过，已中止备份：${integrity.join('; ')}`);
      }
      counts = countTables(snap);
    } finally {
      snap.close();
    }

    // 2) 封装：魔数 + 清单长度 + 清单 JSON + 快照载荷（清单内含载荷 SHA-256）
    const payload = fs.readFileSync(tmpSnapshot);
    const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
    const header = {
      format: 'cue-rehearsal-backup',
      format_version: FORMAT_VERSION,
      app_version: APP_VERSION,
      created_at: createdAt,
      db_size: payload.length,
      sha256,
      tables: counts,
    };
    const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
    const container = Buffer.concat([
      MAGIC,
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32BE(headerBuf.length, 0);
        return b;
      })(),
      headerBuf,
      payload,
    ]);

    // 3) 同目录临时文件 + fsync + rename 原子落地；权限固定 0600
    const tmpOut = path.join(outDir, `.${path.basename(outPath)}.tmp-${process.pid}`);
    const fd = fs.openSync(tmpOut, 'w', 0o600);
    try {
      fs.writeSync(fd, container, 0, container.length, 0);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpOut, outPath);
    fsyncDir(outDir);
  } finally {
    // 在线备份可能在临时库旁留下 -wal/-shm，一并清理
    fs.rmSync(tmpSnapshot, { force: true });
    fs.rmSync(`${tmpSnapshot}-wal`, { force: true });
    fs.rmSync(`${tmpSnapshot}-shm`, { force: true });
  }

  const finalStat = fs.statSync(outPath);
  return {
    outPath: path.resolve(outPath),
    size: finalStat.size,
    mode: finalStat.mode & 0o777,
    created_at: createdAt,
    counts,
  };
}

/**
 * 解析容器并返回 { header, payload }；魔数/清单/载荷长度/SHA-256 任一不符即拒绝。
 */
function parseContainer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < MAGIC.length + 4) {
    throw new BackupError('备份文件过小或已损坏：不是有效的单文件备份（缺少文件头）');
  }
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BackupError('备份文件魔数不匹配：不是本系统导出的单文件备份（或文件已损坏）');
  }
  const headerLen = buf.readUInt32BE(MAGIC.length);
  const headerStart = MAGIC.length + 4;
  if (headerLen === 0 || headerStart + headerLen > buf.length) {
    throw new BackupError('备份清单长度异常或已损坏：无法读取备份清单');
  }
  let header;
  try {
    header = JSON.parse(buf.subarray(headerStart, headerStart + headerLen).toString('utf8'));
  } catch {
    throw new BackupError('备份清单不是合法 JSON：文件已损坏或被篡改');
  }
  if (!header || header.format !== 'cue-rehearsal-backup') {
    throw new BackupError('备份清单格式标识不匹配：不是本系统导出的备份');
  }
  if (header.format_version !== FORMAT_VERSION) {
    throw new BackupError(
      `备份格式版本不受支持：备份为 v${header.format_version}，本工具支持 v${FORMAT_VERSION}`
    );
  }
  const payload = buf.subarray(headerStart + headerLen);
  if (typeof header.db_size === 'number' && payload.length !== header.db_size) {
    throw new BackupError(
      `备份载荷长度不一致：清单记录 ${header.db_size} 字节，实际 ${payload.length} 字节（文件可能被截断）`
    );
  }
  if (typeof header.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(header.sha256)) {
    throw new BackupError('备份清单缺少有效的 SHA-256 校验和');
  }
  const actual = crypto.createHash('sha256').update(payload).digest('hex');
  if (actual !== header.sha256) {
    throw new BackupError('备份校验和不匹配：文件已损坏或被篡改（SHA-256 校验失败，已拒绝恢复）');
  }
  if (!header.tables || typeof header.tables !== 'object') {
    throw new BackupError('备份清单缺少表行数统计');
  }
  return { header, payload };
}

/**
 * 对载荷数据库执行完整性 / 结构兼容性 / 引用关系校验；返回表行数。
 * 任一问题聚合成中文错误抛出。
 */
function validatePayload(payloadBuf) {
  const tmpDb = path.join(
    os.tmpdir(),
    `crbk-verify-${process.pid}-${crypto.randomBytes(6).toString('hex')}.db`
  );
  let db;
  try {
    // 校验副本只落在系统临时目录：无论通过与否，目标目录都不被触碰
    const fd = fs.openSync(tmpDb, 'w', 0o600);
    try {
      fs.writeSync(fd, payloadBuf, 0, payloadBuf.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmpDb, 0o600);

    try {
      db = new Database(tmpDb, { readonly: true });
    } catch (e) {
      throw new BackupError(`备份载荷不是有效的 SQLite 数据库文件：${e.message}`);
    }

    const problems = [];

    // 1) 完整性（损坏到无法查询时，作为完整性失败而非原始异常）
    let integrity;
    try {
      integrity = db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]);
    } catch (e) {
      throw new BackupError(`备份载荷无法作为 SQLite 数据库读取（完整性校验中止：${e.message}）；备份可能已损坏`);
    }
    if (integrity.length !== 1 || integrity[0] !== 'ok') {
      problems.push(`数据库完整性检查未通过：${integrity.slice(0, 5).join('; ')}`);
    }

    // 结构与引用检查需要能正常读表；完整性已坏则后续查询无意义
    if (problems.length === 0) {
      // 2) 结构兼容性：必备表与关键列齐备
      let tables;
      try {
        tables = new Set(
          db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
            .all()
            .map((r) => r.name)
        );
      } catch (e) {
        throw new BackupError(`备份载荷结构无法读取：${e.message}；备份可能已损坏`);
      }
      for (const t of TABLES) {
        if (!tables.has(t)) problems.push(`缺少必需的数据表：${t}`);
      }
      for (const [t, cols] of Object.entries(REQUIRED_COLUMNS)) {
        if (!tables.has(t)) continue;
        const have = new Set(db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name));
        for (const c of cols) {
          if (!have.has(c)) problems.push(`表 ${t} 缺少必需列：${c}（备份与当前版本结构不兼容）`);
        }
      }

      if (problems.length === 0) {
        // 3) SQLite 声明的外键关系（快照表未全部声明外键，下面另有逻辑引用校验）
        const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
        if (fkViolations.length > 0) {
          problems.push(
            `外键引用存在 ${fkViolations.length} 处异常，例如：表 ${fkViolations[0].table} 行 ${fkViolations[0].rowid} 引用缺失`
          );
        }

        // 4) 业务引用关系 + 取值域
        for (const check of [...REFERENCE_CHECKS, ...DOMAIN_CHECKS]) {
          let n;
          try {
            n = db.prepare(check.sql).get().n;
          } catch (e) {
            problems.push(`${check.name}：校验查询失败（${e.message}）`);
            continue;
          }
          if (n > 0) problems.push(`${check.name}（${n} 行）`);
        }
      }
    }

    if (problems.length > 0) {
      throw new BackupError(
        `备份校验失败，已拒绝恢复（目标数据未做任何改动）：\n  - ${problems.join('\n  - ')}`
      );
    }

    return { counts: countTables(db) };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // 忽略关闭异常，继续清理临时文件
      }
    }
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(`${tmpDb}-wal`, { force: true });
    fs.rmSync(`${tmpDb}-shm`, { force: true });
  }
}

/**
 * 恢复：校验备份 → 校验目标为空目录 → 原子落地 app.db。
 */
function restore(backupPath, targetDir) {
  if (!fs.existsSync(backupPath) || !fs.statSync(backupPath).isFile()) {
    throw new BackupError(`备份文件不存在：${backupPath}`);
  }
  if (!fs.existsSync(targetDir)) {
    throw new BackupError(`目标数据目录不存在：${targetDir}（请先创建并确认为空目录）`);
  }
  if (!fs.statSync(targetDir).isDirectory()) {
    throw new BackupError(`恢复目标不是目录：${targetDir}`);
  }
  const entries = fs.readdirSync(targetDir);
  if (entries.length > 0) {
    throw new BackupError(
      `目标数据目录非空：${targetDir}（含 ${entries.slice(0, 5).join('、')}${
        entries.length > 5 ? ' 等' : ''
      }）；恢复要求停服后的空数据目录，已拒绝且目标数据未做任何改动`
    );
  }

  // 1) 校验和 / 完整性 / 结构兼容性 / 引用关系（全部在系统临时目录完成）
  const buf = fs.readFileSync(backupPath);
  const { header, payload } = parseContainer(buf);
  const { counts } = validatePayload(payload);

  // 2) 原子落地：目录内临时文件（0600）→ fsync → rename → fsync 目录
  const finalPath = path.join(targetDir, DB_FILENAME);
  const tmpPath = path.join(targetDir, `.${DB_FILENAME}.restore-tmp-${process.pid}`);
  try {
    const payloadOffset = MAGIC.length + 4;
    const headerLen = buf.readUInt32BE(MAGIC.length);
    const payload = buf.subarray(payloadOffset + headerLen);

    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      fs.writeSync(fd, payload, 0, payload.length, 0);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, finalPath);
    fsyncDir(targetDir);
    fs.chmodSync(finalPath, 0o600);
  } catch (e) {
    fs.rmSync(tmpPath, { force: true });
    if (e instanceof BackupError) throw e;
    throw new BackupError(`备份落地失败：${e.message}（目标数据未做任何改动）`);
  }

  return {
    finalPath: path.resolve(finalPath),
    mode: fs.statSync(finalPath).mode & 0o777,
    counts,
    backupCreatedAt: header.created_at,
    backupAppVersion: header.app_version,
  };
}

/* --------------------------------- CLI --------------------------------- */

function usage() {
  return [
    '用法：',
    '  node src/backup.js backup <输出备份文件> [--db 数据库路径]',
    '  node src/backup.js restore <备份文件> <空数据目录>',
    '',
    '数据库路径默认取环境变量 DB_PATH，其次 ./data/app.db。',
  ].join('\n');
}

function parseArgs(argv) {
  const positional = [];
  let dbOpt = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--db') {
      dbOpt = argv[++i];
      if (!dbOpt) throw new BackupError('--db 缺少数据库路径参数');
    } else if (a === '--help' || a === '-h') {
      return { help: true, positional };
    } else {
      positional.push(a);
    }
  }
  return { help: false, dbOpt, positional };
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    console.error(`错误：${e.message}`);
    console.error(usage());
    return 1;
  }
  if (parsed.help) {
    console.log(usage());
    return 0;
  }
  const [command, ...rest] = parsed.positional;

  try {
    if (command === 'backup') {
      const [outPath] = rest;
      if (!outPath) {
        console.error('错误：缺少备份输出文件参数');
        console.error(usage());
        return 1;
      }
      const dbPath = parsed.dbOpt || defaultDbPath();
      const result = await backup(dbPath, outPath);
      const ts = new Date(result.created_at * 1000).toISOString();
      console.log('备份完成（服务运行期间在线一致性快照）');
      console.log(`  输出文件：${result.outPath}`);
      console.log(`  生成时刻：${ts}（墙钟秒 ${result.created_at.toFixed(3)}）`);
      console.log(`  文件大小：${result.size} 字节；权限 0${result.mode.toString(8)}（仅当前运行用户可读写）`);
      console.log(`  内容统计：${summarizeCounts(result.counts)}`);
      console.log('  安全提示：本输出不含任何控制密钥或交接凭证的回显，但密钥/凭证仍按原值保存在库内，请妥善保管文件');
      return 0;
    }

    if (command === 'restore') {
      const [backupPath, targetDir] = rest;
      if (!backupPath || !targetDir) {
        console.error('错误：restore 需要 <备份文件> 与 <空数据目录> 两个参数');
        console.error(usage());
        return 1;
      }
      const result = restore(backupPath, targetDir);
      const ts = new Date(result.backupCreatedAt * 1000).toISOString();
      console.log('备份校验通过：校验和、数据库完整性、结构兼容性与引用关系均无异常');
      console.log(`  备份生成时刻：${ts}（应用版本 v${result.backupAppVersion}）`);
      console.log(`  内容统计：${summarizeCounts(result.counts)}`);
      console.log(`已原子恢复到：${result.finalPath}（权限 0${result.mode.toString(8)}）`);
      console.log('  版本快照编号、房间播放基准墙钟、定时启播绝对时刻、交接凭证到期时刻均按备份原值保留');
      console.log('  现在可以按原启动方式启动服务（npm start / docker compose up -d）');
      return 0;
    }

    console.error(`错误：未知子命令 ${JSON.stringify(command || '')}`);
    console.error(usage());
    return 1;
  } catch (e) {
    if (e instanceof BackupError) {
      console.error(`错误：${e.message}`);
      return 1;
    }
    console.error(`错误：${e.stack || e.message}`);
    return 1;
  }
}

module.exports = { backup, restore, parseContainer, validatePayload, BackupError };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
