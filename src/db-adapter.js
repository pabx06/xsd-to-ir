'use strict';

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
 * The adapter is DB-agnostic: any knex-supported dialect works
 * (PostgreSQL recommended for production, SQLite for dev/test).
 *
 * Usage:
 *   const knex   = require('knex')({ client: 'pg', connection: { ... } });
 *   const db     = new DBAdapter(knex, ir);
 *
 *   // Persist a full deserialized message
 *   await db.persistMessage(batches, msgMeta);
 *
 *   // Query all rows for a given entity (for XML export)
 *   const rows = await db.queryEntity('task');
 *
 *   // Query only rows changed since msg seq 42 (delta / net-change)
 *   const rows = await db.queryEntity('task', { since: 42 });
 *
 *   // After export: mark rows as exported at this seq number
 *   await db.markExported(['task', 'breakdown'], currentSeq);
 */

// ─── constants ────────────────────────────────────────────────────────────────

const TECH_COLS = new Set([
  'id', '_created_at', '_updated_at', '_deleted_at', '_msg_seq',
]);

// ─── DBAdapter ────────────────────────────────────────────────────────────────

class DBAdapter {
  /**
   * @param {import('knex').Knex} knex  A configured knex instance.
   * @param {object}              ir    The IR returned by IRBuilder.build().
   */
  constructor(knex, ir) {
    this.knex = knex;
    this.ir   = ir;
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
      .map(s => s.trim())
      .filter(Boolean);

    for (const stmt of statements) {
      try {
        await this.knex.raw(stmt + ';');
      } catch (err) {
        // Skip "already exists" errors — useful for idempotent migration
        if (!err.message.includes('already exists')) throw err;
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
    const clean  = this._stripTechCols(row);
    const now    = new Date();

    const payload = {
      ...clean,
      _created_at: now,
      _updated_at: now,
      _msg_seq   : 0,
    };

    const qb = (opts.trx ?? this.knex)(entity.tableName);
    const [inserted] = await qb.insert(payload).returning('*');
    return inserted;
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
    const clean  = this._stripTechCols(row);

    const payload = {
      ...clean,
      _updated_at: new Date(),
    };

    const qb = (opts.trx ?? this.knex)(entity.tableName);
    return qb.where('uid', uid).whereNull('_deleted_at').update(payload);
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
    const qb     = (opts.trx ?? this.knex)(entity.tableName);
    return qb.where('uid', uid).whereNull('_deleted_at').update({
      _deleted_at: new Date(),
      _updated_at: new Date(),
    });
  }

  // ── batch / message persistence ───────────────────────────────────────────

  /**
   * Persist a full deserialized message in a single DB transaction.
   *
   * @param {Map}    batches   Output of XMLDeserializer.deserialize().batches
   * @param {object} msgMeta   Output of XMLDeserializer.deserialize().msgMeta
   * @returns {{ inserted: number, updated: number, deleted: number }}
   */
  async persistMessage(batches, msgMeta) {
    let inserted = 0, updated = 0, deleted = 0;

    await this.knex.transaction(async (trx) => {
      // Optionally log the message header itself
      // (you could persist msgMeta to a messages_log table here)

      for (const [entityName, batch] of batches) {
        // INSERT
        for (const row of batch.insert) {
          await this.insert(entityName, row, { trx });
          inserted++;
        }

        // UPDATE
        for (const row of batch.update) {
          const uid = row._xmlUid;
          if (!uid) continue;
          const { _xmlUid, ...clean } = row; // eslint-disable-line no-unused-vars
          await this.update(entityName, uid, clean, { trx });
          updated++;
        }

        // SOFT DELETE
        for (const uid of batch.delete) {
          await this.softDelete(entityName, uid, { trx });
          deleted++;
        }
      }
    });

    return { inserted, updated, deleted };
  }

  // ── query for export ──────────────────────────────────────────────────────

  /**
   * Query all active rows for an entity, optionally filtered for delta export.
   *
   * @param {string} entityName
   * @param {object} [opts]
   * @param {number} [opts.since]       _msg_seq threshold for net-change export
   * @param {string} [opts.msgStatus]   Filter by status column if present
   * @returns {object[]}  Array of DB rows
   */
  async queryEntity(entityName, opts = {}) {
    const entity = this._entity(entityName);

    let qb = this.knex(entity.tableName).whereNull('_deleted_at');

    // Net-change: rows whose _msg_seq is less than or equal to the
    // *current* export sequence are "already exported".
    // We want rows modified AFTER the last export → _msg_seq > since
    if (opts.since !== undefined && opts.since !== null) {
      qb = qb.where('_msg_seq', '>', opts.since);
    }

    // Optionally filter by a status column (not all entities have one)
    if (opts.msgStatus) {
      const hasStatus = entity.columns.some(c => c.columnName === 'status');
      if (hasStatus) qb = qb.where('status', opts.msgStatus);
    }

    return qb.select('*');
  }

  /**
   * Query rows that were soft-deleted since a given _msg_seq.
   * These must be included in net-change exports with crud="D".
   *
   * @param {string} entityName
   * @param {number} since   _msg_seq baseline
   * @returns {object[]}
   */
  async queryDeleted(entityName, since) {
    const entity = this._entity(entityName);
    return this.knex(entity.tableName)
      .whereNotNull('_deleted_at')
      .where('_msg_seq', '>', since)
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
        await trx(entity.tableName)
          .where('_msg_seq', '<', newSeq)
          .whereNull('_deleted_at')
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
      const hasSeq = entity.columns.some(c => c.columnName === '_msg_seq');
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

  _stripTechCols(row) {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      if (!TECH_COLS.has(k) && k !== '_xmlUid') out[k] = v;
    }
    return out;
  }
}

module.exports = { DBAdapter };