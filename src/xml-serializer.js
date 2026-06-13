'use strict';

/**
 * xml-serializer.js
 *
 * Reconstructs a valid S3000L lsaDataset XML message from DB rows.
 *
 * The serializer is the exact reverse of xml-deserializer.js:
 *
 *   DB rows  →  JS object tree  →  XML string
 *
 * It uses the IR to know:
 *   - Which columns map to XML attributes vs child elements
 *   - Which columns are JSONB (re-expanded as nested XML nodes)
 *   - Which entities belong in lsaPrimaryData vs lsaSupportingData
 *
 * The envelope nodes (lsaDataset, logisticsSupportAnalysisData,
 * lsaPrimaryData, lsaSupportingData) are never stored in the DB —
 * they are always reconstructed here.
 *
 * Output modes:
 *   B (Baseline)  — all active rows, crud="I" on every record
 *   U (NetChange) — only rows changed since last export seq,
 *                   with per-row crud="I"|"U"|"D"
 *
 * Usage:
 *   const { XMLSerializer } = require('./xml-serializer');
 *   const s = new XMLSerializer(ir, db);
 *
 *   const xml = await s.serialize({
 *     msgType  : 'B',        // 'B' | 'U'
 *     msgStatus: 'F',        // 'D' | 'P' | 'F'
 *     since    : null,       // for 'U': last _msg_seq value
 *     collections: null,     // null = all; or ['tasks', 'breakdowns']
 *     msgId    : 'MSG-001',
 *   });
 */

const { XMLBuilder } = require('fast-xml-parser');
const { PRIMARY_COLLECTIONS } = require('./xml-deserializer');

// ─── XML builder config ───────────────────────────────────────────────────────

function _makeBuilder() {
  return new XMLBuilder({
    ignoreAttributes  : false,
    attributeNamePrefix: '@_',
    format            : true,
    indentBy          : '  ',
    suppressEmptyNode : true,
  });
}

// ─── naming helpers ───────────────────────────────────────────────────────────

// snake_case → camelCase
const _toCamel = s => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

// camelCase entity name → plural collection key
// We just append 's'; caller can override with COLLECTION_OVERRIDES below.
const COLLECTION_OVERRIDES = {
  breakdownElement         : 'breakdownElements',
  productOperationalRoleKit: 'productOperationalRoleKits',
  facility                 : 'facilities',
  country                  : 'countries',
  trade                    : 'trades',
  skill                    : 'skills',
  contract                 : 'contracts',
  project                  : 'projects',
  document                 : 'documents',
  organization             : 'organizations',
  infrastructure           : 'infrastructures',
  substanceDefinition      : 'substanceDefinitions',
};

function _collectionKey(entityName) {
  return COLLECTION_OVERRIDES[entityName] ?? (entityName + 's');
}

// ─── row → XML node ───────────────────────────────────────────────────────────

/**
 * Convert a DB row back to an XML-ready JS object using the IR entity.
 *
 * S3000L convention:
 *   - uid and crud are XML *attributes* (@_ prefix)
 *   - All other columns become child elements
 *   - JSONB columns are re-expanded as nested object/array children
 *
 * @param {object} entity  IR entity
 * @param {object} row     DB row
 * @param {string} crud    'I' | 'U' | 'D'
 */
// Columns that are XML *attributes* in S3000L (not child elements)
const XML_ATTRIBUTE_COLS = new Set(['uid', 'uri', 'crud']);

function _rowToXmlNode(entity, row, crud) {
  const node = {
    '@_crud': crud,
  };

  // Write uid as XML attribute if present
  if (row.uid) node['@_uid'] = row.uid;
  if (row.uri) node['@_uri'] = row.uri;

  for (const col of entity.columns) {
    // Skip internal tech cols
    if (col.columnName === 'id')          continue;
    if (col.columnName.startsWith('_'))   continue;
    // Skip cols already written as attributes
    if (XML_ATTRIBUTE_COLS.has(col.columnName)) continue;

    const val = row[col.columnName];
    if (val === null || val === undefined) continue;

    const xmlKey = _toCamel(col.columnName);

    if (col.sqlType === 'LONGTEXT') {
      // Re-expand JSON string back into nested XML object
      try {
        node[xmlKey] = typeof val === 'string' ? JSON.parse(val) : val;
      } catch {
        node[xmlKey] = val; // fallback: leave as string
      }
    } else if (col.sqlType === 'TINYINT(1)') {
      node[xmlKey] = val ? 'true' : 'false';
    } else if (col.sqlType === 'LONGBLOB') {
      // Base64-encode binary back to XML
      node[xmlKey] = Buffer.isBuffer(val)
        ? val.toString('base64')
        : String(val);
    } else {
      node[xmlKey] = String(val);
    }
  }

  return node;
}

// ─── XMLSerializer ────────────────────────────────────────────────────────────

class XMLSerializer {
  /**
   * @param {object}    ir    IR from IRBuilder.build()
   * @param {DBAdapter} db    DBAdapter instance
   */
  constructor(ir, db) {
    this.ir      = ir;
    this.db      = db;
    this.builder = _makeBuilder();
  }

  // ── main entry point ──────────────────────────────────────────────────────

  /**
   * Serialize DB contents to a valid S3000L XML string.
   *
   * @param {object}   opts
   * @param {string}   opts.msgType       'B' | 'U'
   * @param {string}   opts.msgStatus     'D' | 'P' | 'F'
   * @param {number|null} opts.since      For 'U': last exported _msg_seq
   * @param {string[]|null} opts.collections  Null = all; or subset list
   * @param {string}   [opts.msgId]       Message identifier
   * @param {string}   [opts.relatedMsgId] For net-change: ref to baseline
   * @param {string}   [opts.sendingSystem]
   * @param {string}   [opts.receivingSystem]
   *
   * @returns {string}  Well-formed XML string
   */
  async serialize(opts = {}) {
    const {
      msgType        = 'B',
      msgStatus      = 'F',
      since          = null,
      collections    = null,
      msgId          = `MSG-${Date.now()}`,
      relatedMsgId   = null,
      sendingSystem  = null,
      receivingSystem= null,
    } = opts;

    // ── 1. Build lsaPrimaryData ───────────────────────────────────────────
    const primaryData   = await this._buildSection(
      PRIMARY_COLLECTIONS, msgType, since, collections
    );

    // ── 2. Build lsaSupportingData ────────────────────────────────────────
    const allEntityNames = new Set(this.ir.entities.keys());
    const supportingKeys = new Set(
      [...allEntityNames].filter(n => !PRIMARY_COLLECTIONS.has(n))
    );
    const supportingData = await this._buildSection(
      supportingKeys, msgType, since, collections
    );

    // ── 3. Build the envelope tree ────────────────────────────────────────
    const now     = new Date().toISOString();
    const msgDate = now.split('T')[0];

    const envelope = {
      '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
      lsaDataset: {
        msgId    : msgId,
        msgDate  : msgDate,
        msgType  : { code: msgType },
        msgStatus: { code: msgStatus },

        // Optional header fields
        ...(sendingSystem   ? { msgPty: [
          { partyType: { code: 'SE' }, partyName: sendingSystem   },
          { partyType: { code: 'RE' }, partyName: receivingSystem ?? '' },
        ]} : {}),

        // Link to baseline for net-change messages
        ...(relatedMsgId ? {
          relatedMsg: {
            relType: { code: 'RM' },
            msgRef : relatedMsgId,
          },
        } : {}),

        logisticsSupportAnalysisData: {
          ...(Object.keys(primaryData).length > 0
            ? { lsaPrimaryData: primaryData }
            : {}),
          ...(Object.keys(supportingData).length > 0
            ? { lsaSupportingData: supportingData }
            : {}),
        },
      },
    };

    return this.builder.build(envelope);
  }

  // ── section builder ───────────────────────────────────────────────────────

  /**
   * Build a data section (primary or supporting) by querying each entity.
   *
   * @param {Set<string>}      entitySet
   * @param {string}           msgType    'B' | 'U'
   * @param {number|null}      since
   * @param {string[]|null}    filter     Allowed collection keys (null = all)
   * @returns {object}  Object whose keys are collection names
   */
  async _buildSection(entitySet, msgType, since, filter) {
    const section = {};

    for (const entityName of entitySet) {
      const collKey = _collectionKey(entityName);

      // Apply optional collection filter
      if (filter !== null && !filter.includes(collKey) && !filter.includes(entityName)) {
        continue;
      }

      if (!this.ir.entities.has(entityName)) continue;
      const entity = this.ir.entities.get(entityName);

      // ── Active rows ──────────────────────────────────────────────────────
      const queryOpts = msgType === 'U' && since !== null ? { since } : {};
      const rows = await this.db.queryEntity(entityName, queryOpts);

      // ── Deleted rows (net-change only) ────────────────────────────────
      let deletedRows = [];
      if (msgType === 'U' && since !== null) {
        deletedRows = await this.db.queryDeleted(entityName, since);
      }

      if (rows.length === 0 && deletedRows.length === 0) continue;

      // ── Map rows → XML nodes ─────────────────────────────────────────
      const xmlNodes = [
        ...rows.map(row => {
          // For baseline: always 'I'
          // For net-change: rows that existed before this export but changed
          // are 'U'; new rows are 'I'.  We use _created_at vs _updated_at
          // to distinguish new vs updated.
          let crud = 'I';
          if (msgType === 'U' && since !== null) {
            const created = row._created_at ? new Date(row._created_at) : null;
            const updated = row._updated_at ? new Date(row._updated_at) : null;
            if (created && updated && updated > created) crud = 'U';
          }
          return _rowToXmlNode(entity, row, crud);
        }),
        ...deletedRows.map(row => ({
          '@_crud': 'D',
          '@_uid' : row.uid,
        })),
      ];

      if (xmlNodes.length > 0) {
        // Nest nodes under the singular entity name inside the collection
        section[collKey] = { [entityName]: xmlNodes };
      }
    }

    return section;
  }
}

// ─── standalone serialize helper ─────────────────────────────────────────────

/**
 * One-shot convenience: serialize without constructing XMLSerializer manually.
 *
 * @param {object}    ir
 * @param {DBAdapter} db
 * @param {object}    opts  Same as XMLSerializer.serialize opts
 * @returns {Promise<string>}
 */
async function serializeToXML(ir, db, opts = {}) {
  return new XMLSerializer(ir, db).serialize(opts);
}

module.exports = { XMLSerializer, serializeToXML };
