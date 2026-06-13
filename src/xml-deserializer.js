'use strict';

/**
 * xml-deserializer.js
 *
 * Converts a parsed S3000L XML message (JS object from fast-xml-parser)
 * into a set of DB-ready row batches, respecting:
 *
 *   - The envelope hierarchy (lsaDataset → logisticsSupportAnalysisData →
 *     lsaPrimaryData / lsaSupportingData → collections → records)
 *   - The crud attribute per record (I / U / D)
 *   - IR-driven column coercion (XML string → correct JS type for the DB)
 *   - JSONB columns (nested complex types stored as JSON)
 *   - Relations (FK columns populated from nested entity uid attributes)
 *
 * Output shape:
 *   {
 *     msgMeta : { msgId, msgType, msgStatus, msgDate, relatedMsgId }
 *     batches : Map<entityName, { insert: row[], update: row[], delete: uid[] }>
 *   }
 *
 * Usage:
 *   const { XMLDeserializer } = require('./xml-deserializer');
 *   const d = new XMLDeserializer(ir);
 *   const { msgMeta, batches } = d.deserialize(parsedXmlObject);
 */

const { XMLParser } = require('fast-xml-parser');

// ─── S3000L envelope constants ────────────────────────────────────────────────

// Collections that live under lsaPrimaryData
const PRIMARY_COLLECTIONS = new Set([
  'breakdownElements', 'parts', 'productOperationalRoleKits',
  'products', 'taskRequirements', 'tasks',
]);

// Singular name for each collection key  (pluralCollection → singularRecord)
// Built lazily from the IR entity names; overrides for irregular plurals:
const IRREGULAR_SINGULAR = {
  breakdownElements         : 'breakdownElement',
  productOperationalRoleKits: 'productOperationalRoleKit',
  facilities                : 'facility',
  countries                 : 'country',
  trades                    : 'trade',
  skills                    : 'skill',
  contracts                 : 'contract',
  projects                  : 'project',
  documents                 : 'document',
  organizations             : 'organization',
  infrastructures           : 'infrastructure',
  substances                : 'substance',
};

function _singularOf(pluralKey) {
  if (IRREGULAR_SINGULAR[pluralKey]) return IRREGULAR_SINGULAR[pluralKey];
  // Standard rule: strip trailing 's'
  if (pluralKey.endsWith('s')) return pluralKey.slice(0, -1);
  return pluralKey;
}

// ─── type coercion ────────────────────────────────────────────────────────────

/**
 * Coerce an XML string value into the correct JS type for a DB column.
 */
function _coerce(value, sqlType) {
  if (value === undefined || value === null || value === '') return null;

  const v   = String(value).trim();
  const sql = (sqlType || '').toUpperCase();

  if (sql === 'BOOLEAN')  return v === 'true' || v === '1';
  if (sql === 'INTEGER' || sql === 'BIGINT' || sql === 'SMALLINT' ||
      sql === 'BIGSERIAL') return parseInt(v, 10);
  if (sql === 'DECIMAL' || sql === 'FLOAT' || sql.startsWith('DOUBLE')) return parseFloat(v);
  if (sql === 'JSONB')    return typeof value === 'object' ? value : _tryParseJson(v);
  if (sql === 'BYTEA')    return Buffer.from(v, 'base64');
  // TEXT, VARCHAR, CHAR, DATE, TIMESTAMP, etc. → keep as string
  return v;
}

function _tryParseJson(str) {
  try { return JSON.parse(str); } catch { return str; }
}

// ─── XML attribute / element reader ──────────────────────────────────────────

/**
 * Read a value from a parsed XML node.
 * fast-xml-parser puts XML attributes under "@_name" and child elements
 * under their plain name.  We check both.
 */
function _readField(node, fieldName) {
  if (node === null || typeof node !== 'object') return undefined;
  // Try as XML attribute first
  const attrVal = node[`@_${fieldName}`];
  if (attrVal !== undefined) return attrVal;
  // Then as child element
  const elemVal = node[fieldName];
  if (elemVal !== undefined) return elemVal;
  return undefined;
}

// ─── Deserializer ─────────────────────────────────────────────────────────────

class XMLDeserializer {
  /**
   * @param {object} ir  The IR returned by IRBuilder.build()
   */
  constructor(ir) {
    this.ir = ir;
    // Build a quick lookup: collectionKey → entityName
    this._collectionMap = this._buildCollectionMap();
  }

  // ── collection → entity name map ─────────────────────────────────────────

  _buildCollectionMap() {
    const map = new Map();
    for (const [entityName] of this.ir.entities) {
      // Pluralise simply for lookup
      map.set(entityName + 's', entityName);
      // Also index by exact name (for single-record collections)
      map.set(entityName, entityName);
    }
    // Add irregular forms
    for (const [plural, singular] of Object.entries(IRREGULAR_SINGULAR)) {
      if (this.ir.entities.has(singular)) map.set(plural, singular);
    }
    return map;
  }

  _resolveEntity(collectionKey) {
    if (this._collectionMap.has(collectionKey)) {
      return this._collectionMap.get(collectionKey);
    }
    // Try singular
    const singular = _singularOf(collectionKey);
    if (this.ir.entities.has(singular)) return singular;
    // Try as-is
    if (this.ir.entities.has(collectionKey)) return collectionKey;
    return null;
  }

  // ── main entry point ──────────────────────────────────────────────────────

  /**
   * Deserialize a parsed XML object (output of fast-xml-parser) into batches.
   *
   * @param {object} parsed  Result of XMLParser.parse()
   * @returns {{ msgMeta, batches }}
   */
  deserialize(parsed) {
    // Strip namespace prefix on root key if present
    const rootKey = Object.keys(parsed).find(k => {
      const bare = k.includes(':') ? k.split(':').pop() : k;
      return bare === 'lsaDataset';
    });

    if (!rootKey) throw new Error('No <lsaDataset> root found in parsed XML');

    const root = parsed[rootKey];

    // ── 1. Extract message metadata ────────────────────────────────────────
    const msgMeta = this._extractMsgMeta(root);

    // ── 2. Navigate to data containers ────────────────────────────────────
    const lsaData = root.logisticsSupportAnalysisData ?? {};
    const primary  = lsaData.lsaPrimaryData    ?? {};
    const support  = lsaData.lsaSupportingData ?? {};

    // ── 3. Process all collections ─────────────────────────────────────────
    const batches = new Map();

    for (const [collKey, collValue] of Object.entries(primary)) {
      this._processCollection(collKey, collValue, batches);
    }
    for (const [collKey, collValue] of Object.entries(support)) {
      this._processCollection(collKey, collValue, batches);
    }

    return { msgMeta, batches };
  }

  // ── msg metadata ──────────────────────────────────────────────────────────

  _extractMsgMeta(root) {
    const get = (key) => {
      const v = root[key];
      if (!v) return null;
      // S3000L wraps values in <code> child elements: { code: 'B' }
      if (typeof v === 'object' && v.code !== undefined) return String(v.code);
      return String(v);
    };

    const related = root.relatedMsg;
    const relatedMsgId = Array.isArray(related)
      ? related.map(r => r.msgRef).filter(Boolean)
      : related?.msgRef ?? null;

    return {
      msgId       : get('msgId'),
      msgType     : get('msgType'),     // 'B' or 'U'
      msgStatus   : get('msgStatus'),   // 'D','P','F'
      msgDate     : get('msgDate'),
      relatedMsgId,
    };
  }

  // ── collection processing ─────────────────────────────────────────────────

  _processCollection(collKey, collValue, batches) {
    if (!collValue || typeof collValue !== 'object') return;

    const entityName = this._resolveEntity(collKey);
    if (!entityName) return; // unknown collection, skip silently

    const entity = this.ir.entities.get(entityName);
    if (!entity) return;

    // Collection value can be:
    //   - an object with a single child key (the record element name)
    //   - directly an array of records
    //   - a single record object

    let records = this._extractRecords(collValue, entityName);
    if (records.length === 0) return;

    if (!batches.has(entityName)) {
      batches.set(entityName, { insert: [], update: [], delete: [] });
    }
    const batch = batches.get(entityName);

    for (const xmlRecord of records) {
      const crud = (xmlRecord['@_crud'] ?? 'I').toUpperCase();
      const uid  = xmlRecord['@_uid'] ?? xmlRecord['@_id'] ?? null;

      if (crud === 'D') {
        if (uid) batch.delete.push(uid);
        continue;
      }

      const row = this._xmlRecordToRow(entity, xmlRecord);

      if (crud === 'U') {
        row._xmlUid = uid; // preserve for UPDATE WHERE uid = ?
        batch.update.push(row);
      } else {
        // 'I' or any other value → insert
        batch.insert.push(row);
      }
    }
  }

  _extractRecords(collValue, entityName) {
    // If it's already an array, we're done
    if (Array.isArray(collValue)) return collValue;

    // If it's an object, look for the singular child key
    if (typeof collValue === 'object') {
      const singular = _singularOf(entityName);
      // Try entityName and singular as child keys
      for (const key of [entityName, singular, ...Object.keys(collValue)]) {
        const child = collValue[key];
        if (child === undefined) continue;
        if (Array.isArray(child))          return child;
        if (typeof child === 'object')     return [child];
      }
    }
    return [];
  }

  // ── record → DB row ───────────────────────────────────────────────────────

  _xmlRecordToRow(entity, xmlRecord) {
    const row = {};

    for (const col of entity.columns) {
      // Never map surrogate PK or technical tracking cols from XML
      if (col.columnName === 'id')           continue;
      if (col.columnName.startsWith('_'))    continue;

      const raw = _readField(xmlRecord, col.name)
               ?? _readField(xmlRecord, col.columnName);

      if (raw === undefined) {
        row[col.columnName] = null;
        continue;
      }

      if (col.sqlType === 'LONGTEXT' && typeof raw === 'object') {
        // Store the nested XML subtree as JSON string (LONGTEXT column)
        row[col.columnName] = JSON.stringify(raw);
      } else {
        row[col.columnName] = _coerce(raw, col.sqlType);
      }
    }

    return row;
  }
}

// ─── standalone parse helper ──────────────────────────────────────────────────

const _xmlParser = new XMLParser({
  ignoreAttributes   : false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  trimValues         : true,
  isArray: (tag) => {
    // Collections and their records should always be arrays
    const bare = tag.includes(':') ? tag.split(':').pop() : tag;
    return PRIMARY_COLLECTIONS.has(bare);
  },
});

/**
 * Parse an XML string and deserialize it in one call.
 *
 * @param {string} xmlString
 * @param {object} ir          IR from IRBuilder.build()
 * @returns {{ msgMeta, batches }}
 */
function deserializeXML(xmlString, ir) {
  const parsed = _xmlParser.parse(xmlString);
  return new XMLDeserializer(ir).deserialize(parsed);
}

module.exports = { XMLDeserializer, deserializeXML, PRIMARY_COLLECTIONS };