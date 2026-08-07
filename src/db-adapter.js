/**
 * db-adapter.js
 *
 * Thin, IR-aware database layer built on top of knex.
 *
 * Responsibilities:
 *   - Insert / update / soft-delete individual rows
 *   - Persist a full deserialized message (batches) in a single transaction
 *   - Query rows for XML serialization (with optional delta filter)
 *   - Bump _msg_seq after a successful export
 *
 * The production target is MariaDB via knex/mysql2. The implementation keeps
 * the SQL surface small so SQLite can still be used for lightweight tests.
 *
 * Usage:
 *   const knex   = require('knex')({ client: 'mysql2', connection: { ... } });
 *   const db     = new DBAdapter(knex, ir);
 *
 *   // Persist a full deserialized message
 *   await db.persistMessage(batches, msgMeta);
 *
 *   // Query all rows for a given entity (for XML export)
 *   const rows = await db.queryEntity('task');
 *
 *   // Query dirty rows for net-change export
 *   const rows = await db.queryEntity('task', { since: 42 });
 *
 *   // After export: mark rows as exported at this seq number
 *   await db.markExported(['task', 'breakdown'], currentSeq);
 */

// ─── constants ────────────────────────────────────────────────────────────────

const TECH_COLS = new Set([
  'id', '_created_at', '_updated_at', '_deleted_at', '_msg_seq',
]);

const { DBRelationResolver } = require('./db-relation-resolver');

function _isIgnorableDDLExistsError(err) {
  const msg = String(err?.message || '').toLowerCase();
  const code = err?.code;
  const errno = err?.errno;

  return code === 'ER_TABLE_EXISTS_ERROR'
    || code === 'ER_DUP_KEYNAME'
    || code === 'ER_FK_DUP_NAME'
    || errno === 1050
    || errno === 1061
    || errno === 1826
    || msg.includes('already exists')
    || msg.includes('duplicate key name')
    || msg.includes('duplicate foreign key constraint name')
    || msg.includes('duplicate key on write or update');
}

// ─── DBAdapter ────────────────────────────────────────────────────────────────

class DBAdapter {
  /**
   * @param {import('knex').Knex} knex  A configured knex instance.
   * @param {object}              ir    The IR returned by IRBuilder.build().
   */
  constructor(knex, ir) {
    this.knex = knex;
    this.ir = ir;
    this.relationResolver = new DBRelationResolver({
      entityForName: (name) => this._entity(name),
      activeByUid: (entity, uid, trx) => this._activeByUid(entity, uid, trx),
    });
  }

  // ── schema bootstrap ──────────────────────────────────────────────────────

  /**
   * Run the generated SQL DDL to create all tables.
   * Wraps each statement in a try/catch so it can be called on an existing DB
   * (tables that already exist are silently skipped).
   *
   * @param {string} ddlSQL  Full DDL from generateSQL(ir).
   */
  async applyDDL(ddlSQL) {
    const statements = ddlSQL
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const stmt of statements) {
      try {
        await this.knex.raw(`${stmt};`);
      } catch (err) {
        // Skip "already exists" errors — useful for idempotent generated DDL.
        if (!_isIgnorableDDLExistsError(err)) throw err;
      }
    }
  }

  // ── single-row operations ─────────────────────────────────────────────────

  /**
   * Insert a row into an entity table.
   *
   * @param {string} entityName  IR entity name (camelCase, e.g. 'task')
   * @param {object} row         Column → value map (no tech cols needed)
   * @param {object} [opts]
   * @param {object} [opts.trx]  Knex transaction object
   * @returns {object}  The inserted row (with generated id)
   */
  async insert(entityName, row, opts = {}) {
    const entity = this._entity(entityName);
    this._assertRequiredUid(entityName, entity, row?.uid, 'insert');
    const clean = this._stripTechCols(row);
    const now = new Date();

    const payload = { ...clean };
    if (this._hasColumn(entity, '_created_at')) payload._created_at = now;
    if (this._hasColumn(entity, '_updated_at')) payload._updated_at = now;
    if (this._hasColumn(entity, '_msg_seq')) payload._msg_seq = 0;

    const db = opts.trx ?? this.knex;
    const result = await db(entity.tableName).insert(payload);
    const insertedId = Array.isArray(result) ? result[0] : result;

    if (insertedId !== undefined && insertedId !== null) {
      const [inserted] = await db(entity.tableName).where('id', insertedId).select('*');
      return inserted ?? { id: insertedId, ...payload };
    }

    return payload;
  }

  /**
   * Update a row identified by its S3000L uid.
   *
   * @param {string} entityName
   * @param {string} uid          The S3000L uid attribute value
   * @param {object} row          Columns to update
   * @param {object} [opts]
   * @param {object} [opts.trx]
   * @returns {number}  Number of rows affected
   */
  async update(entityName, uid, row, opts = {}) {
    const entity = this._entity(entityName);
    this._assertRequiredUid(entityName, entity, uid, 'update');
    const clean = this._stripTechCols(row);

    const payload = { ...clean };
    if (this._hasColumn(entity, '_updated_at')) payload._updated_at = new Date();
    if (this._hasColumn(entity, '_msg_seq')) payload._msg_seq = 0;

    const qb = (opts.trx ?? this.knex)(entity.tableName);
    let query = qb.where('uid', uid);
    if (this._hasColumn(entity, '_deleted_at')) query = query.whereNull('_deleted_at');
    return query.update(payload);
  }

  /**
   * Soft-delete a row (sets _deleted_at, never hard deletes).
   *
   * @param {string} entityName
   * @param {string} uid
   * @param {object} [opts]
   * @param {object} [opts.trx]
   * @returns {number}  Number of rows affected
   */
  async softDelete(entityName, uid, opts = {}) {
    const entity = this._entity(entityName);
    this._assertRequiredUid(entityName, entity, uid, 'delete');
    const qb = (opts.trx ?? this.knex)(entity.tableName);
    if (!this._hasColumn(entity, '_deleted_at')) return 0;

    const payload = { _deleted_at: new Date() };
    if (this._hasColumn(entity, '_updated_at')) payload._updated_at = new Date();
    if (this._hasColumn(entity, '_msg_seq')) payload._msg_seq = 0;

    return qb.where('uid', uid).whereNull('_deleted_at').update(payload);
  }

  // ── batch / message persistence ───────────────────────────────────────────

  /**
   * Persist a full deserialized message in a single DB transaction.
   *
   * @param {Map}    batches   Output of XMLDeserializer.deserialize().batches
   * @param {object} msgMeta   Output of XMLDeserializer.deserialize().msgMeta
   * @returns {{ inserted: number, updated: number, deleted: number }}
   */
  async persistMessage(batches, _msgMeta) {
    let inserted = 0;
    let updated = 0;
    let deleted = 0;

    this._preflightRequiredUids(batches);

    await this.knex.transaction(async (trx) => {
      const pendingRelations = [];
      // Optionally log the message header itself
      // (you could persist msgMeta to a messages_log table here)

      for (const [entityName, batch] of batches) {
        // INSERT
        for (const row of batch.insert) {
          const relationRefs = row._xmlRelations || [];
          const resolved = await this.relationResolver.resolveParentRef(row, trx);
          const insertedRow = await this.insert(entityName, resolved, { trx });
          this.relationResolver.queueRelationRefs(
            pendingRelations,
            entityName,
            insertedRow.id,
            relationRefs,
          );
          inserted++;
        }

        // UPDATE
        for (const row of batch.update) {
          const uid = row._xmlUid;
          if (!uid) continue;
          const relationRefs = row._xmlRelations || [];
          const { _xmlUid, ...clean } = row; // eslint-disable-line no-unused-vars
          const resolved = await this.relationResolver.resolveParentRef(clean, trx);
          await this.update(entityName, uid, resolved, { trx });
          if (relationRefs.length > 0) {
            const source = await this._activeByUid(this._entity(entityName), uid, trx);
            if (source) {
              this.relationResolver.queueRelationRefs(pendingRelations, entityName, source.id, relationRefs);
            }
          }
          updated++;
        }

        // SOFT DELETE
        for (const uid of batch.delete) {
          await this.softDelete(entityName, uid, { trx });
          deleted++;
        }
      }

      await this.relationResolver.applyPendingRelationRefs(pendingRelations, trx);
    });

    return { inserted, updated, deleted };
  }

  // ── query for export ──────────────────────────────────────────────────────

  /**
   * Query all active rows for an entity, optionally filtered for delta export.
   *
   * @param {string} entityName
   * @param {object} [opts]
   * @param {number} [opts.since]       Enables dirty-row filtering for net-change export
   * @param {string} [opts.msgStatus]   Filter by status column if present
   * @returns {object[]}  Array of DB rows
   */
  async queryEntity(entityName, opts = {}) {
    const entity = this._entity(entityName);

    let qb = this.knex(entity.tableName);
    if (this._hasColumn(entity, '_deleted_at')) {
      qb = qb.whereNull('_deleted_at');
    }

    // Net-change: _msg_seq = 0 means dirty/unexported. markExported()
    // stamps exported rows with the message sequence after the XML is sent.
    if (opts.since !== undefined && opts.since !== null && this._hasColumn(entity, '_msg_seq')) {
      qb = qb.where('_msg_seq', 0);
    }

    // Optionally filter by a status column (not all entities have one)
    if (opts.msgStatus) {
      const hasStatus = entity.columns.some((c) => c.columnName === 'status');
      if (hasStatus) qb = qb.where('status', opts.msgStatus);
    }

    return qb.select('*');
  }

  /**
   * Query active child rows that belong to a parent row through an IR-generated
   * relationship FK column.
   *
   * @param {string} entityName
   * @param {string} parentColumn
   * @param {number|string} parentId
   * @param {object} [opts]
   * @param {number} [opts.since]  Enables dirty-row filtering for net-change export
   * @returns {object[]}
   */
  async queryRelated(entityName, parentColumn, parentId, opts = {}) {
    const entity = this._entity(entityName);

    let qb = this.knex(entity.tableName)
      .where(parentColumn, parentId);

    if (this._hasColumn(entity, '_deleted_at')) {
      qb = qb.whereNull('_deleted_at');
    }

    if (opts.since !== undefined && opts.since !== null && this._hasColumn(entity, '_msg_seq')) {
      qb = qb.where('_msg_seq', 0);
    }

    return qb.select('*');
  }

  /**
   * Query one row by surrogate id for relation reconstruction.
   *
   * @param {string} entityName
   * @param {number|string} id
   * @param {object} [opts]
   * @param {number} [opts.since]  Enables dirty-row filtering for net-change export
   * @returns {object|null}
   */
  async queryById(entityName, id, opts = {}) {
    const entity = this._entity(entityName);
    let qb = this.knex(entity.tableName).where('id', id);

    if (this._hasColumn(entity, '_deleted_at')) {
      qb = qb.whereNull('_deleted_at');
    }

    if (opts.since !== undefined && opts.since !== null && this._hasColumn(entity, '_msg_seq')) {
      qb = qb.where('_msg_seq', 0);
    }

    const [row] = await qb.select('*');
    return row || null;
  }

  /**
   * Query dirty rows that were soft-deleted and still need export.
   * These must be included in net-change exports with crud="D".
   *
   * @param {string} entityName
   * @param {number} since   Last exported sequence. Kept for API symmetry.
   * @returns {object[]}
   */
  async queryDeleted(entityName, _since) {
    const entity = this._entity(entityName);
    if (!this._hasColumn(entity, '_deleted_at') || !this._hasColumn(entity, '_msg_seq')) {
      return [];
    }
    return this.knex(entity.tableName)
      .whereNotNull('_deleted_at')
      .where('_msg_seq', 0)
      .select('id', 'uid', '_deleted_at');
  }

  // ── post-export bookkeeping ───────────────────────────────────────────────

  /**
   * After a successful XML export, stamp all exported rows with the new
   * _msg_seq so they won't appear in the next net-change export.
   *
   * Call this ONLY after the XML file has been confirmed written/sent.
   *
   * @param {string[]} entityNames  Which entities were exported
   * @param {number}   newSeq       The sequence number of the just-written message
   */
  async markExported(entityNames, newSeq) {
    await this.knex.transaction(async (trx) => {
      for (const entityName of entityNames) {
        const entity = this._entity(entityName);
        if (!this._hasColumn(entity, '_msg_seq')) continue;
        await trx(entity.tableName)
          .where('_msg_seq', 0)
          .update({ _msg_seq: newSeq });
      }
    });
  }

  /**
   * Get the current maximum _msg_seq across all entities.
   * Use this to assign the sequence number of the next export.
   *
   * @returns {number}
   */
  async currentMaxSeq() {
    let max = 0;
    for (const [entityName] of this.ir.entities) {
      const entity = this.ir.entities.get(entityName);
      const hasSeq = entity.columns.some((c) => c.columnName === '_msg_seq');
      if (!hasSeq) continue;
      const [row] = await this.knex(entity.tableName).max('_msg_seq as m');
      const v = Number(row?.m ?? 0);
      if (v > max) max = v;
    }
    return max;
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  _entity(name) {
    const e = this.ir.entities.get(name);
    if (!e) throw new Error(`Unknown entity in IR: "${name}"`);
    return e;
  }

  _hasColumn(entity, columnName) {
    return entity.columns.some((c) => c.columnName === columnName);
  }

  _requiresUid(entity) {
    return entity.columns.some(
      (col) => col.columnName === 'uid' && col.nullable === false,
    );
  }

  _assertRequiredUid(entityName, entity, uid, operation) {
    if (!this._requiresUid(entity) || uid) return;
    throw new Error(
      `Cannot ${operation} ${entityName}: `
      + 'uid is required by the generated database model',
    );
  }

  _preflightRequiredUids(batches) {
    for (const [entityName, batch] of batches) {
      const entity = this._entity(entityName);
      if (!this._requiresUid(entity)) continue;

      for (const row of (batch.insert || [])) {
        this._assertRequiredUid(entityName, entity, row?.uid, 'insert');
      }
      for (const row of (batch.update || [])) {
        this._assertRequiredUid(entityName, entity, row?._xmlUid, 'update');
      }
      for (const uid of (batch.delete || [])) {
        this._assertRequiredUid(entityName, entity, uid, 'delete');
      }
    }
  }

  _stripTechCols(row) {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      if (!TECH_COLS.has(k) && !k.startsWith('_xml')) out[k] = v;
    }
    return out;
  }

  async _activeByUid(entity, uid, trx) {
    let query = trx(entity.tableName).where('uid', uid);
    if (this._hasColumn(entity, '_deleted_at')) {
      query = query.whereNull('_deleted_at');
    }
    const [row] = await query.select('id');
    return row || null;
  }
}

module.exports = { DBAdapter };
