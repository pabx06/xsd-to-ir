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
 *   - LONGTEXT JSON columns (nested complex types stored as JSON strings)
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
const { validateValueAssertions } = require('./assertion-validator');
const {
  IRREGULAR_SINGULAR,
  PRIMARY_COLLECTIONS,
  collectionEntries,
  isXmlImportColumn,
  readColumnField,
  readField,
  relationColumn,
  singularOf,
} = require('./s3000l-xml-metadata');

// ─── type coercion ────────────────────────────────────────────────────────────

/**
 * Coerce an XML string value into the correct JS type for a DB column.
 */
function _coerce(value, sqlType) {
  if (value === undefined || value === null || value === '') return null;

  const v = String(value).trim();
  const sql = (sqlType || '').toUpperCase();

  if (sql === 'BOOLEAN') return v === 'true' || v === '1';
  if (sql === 'INTEGER' || sql === 'BIGINT' || sql === 'SMALLINT'
      || sql === 'BIGSERIAL') return parseInt(v, 10);
  if (sql === 'DECIMAL' || sql === 'FLOAT' || sql.startsWith('DOUBLE')) return parseFloat(v);
  if (sql === 'JSONB') return typeof value === 'object' ? value : _tryParseJson(v);
  if (sql === 'BYTEA') return Buffer.from(v, 'base64');
  // TEXT, VARCHAR, CHAR, DATE, TIMESTAMP, etc. → keep as string
  return v;
}

function _tryParseJson(str) {
  try { return JSON.parse(str); } catch { return str; }
}

function _valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// ─── Deserializer ─────────────────────────────────────────────────────────────

class XMLDeserializer {
  /**
   * @param {object} ir  The IR returned by IRBuilder.build()
   */
  constructor(ir) {
    this.ir = ir;
    this._collectionRecords = this._buildCollectionRecordMap();
    // Build a quick lookup: collectionKey → entityName
    this._collectionMap = this._buildCollectionMap();
  }

  // ── collection → entity name map ─────────────────────────────────────────

  _buildCollectionRecordMap() {
    const map = new Map();
    for (const meta of collectionEntries(this.ir)) {
      if (!this.ir.entities.has(meta.entityName)) continue;
      if (!map.has(meta.collectionName)) map.set(meta.collectionName, new Map());
      map.get(meta.collectionName).set(meta.recordName, meta.entityName);
    }
    return map;
  }

  _buildCollectionMap() {
    const map = new Map();
    for (const [collectionName, records] of this._collectionRecords) {
      if (records.size === 1) {
        map.set(collectionName, [...records.values()][0]);
      }
    }
    for (const [entityName] of this.ir.entities) {
      // Pluralise simply for lookup
      map.set(`${entityName}s`, entityName);
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
    const singular = singularOf(collectionKey);
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
    const rootKey = Object.keys(parsed).find((k) => {
      const bare = k.includes(':') ? k.split(':').pop() : k;
      return bare === 'lsaDataset';
    });

    if (!rootKey) throw new Error('No <lsaDataset> root found in parsed XML');

    const root = parsed[rootKey];

    // ── 1. Extract message metadata ────────────────────────────────────────
    const msgMeta = this._extractMsgMeta(root);

    // ── 2. Navigate to data containers ────────────────────────────────────
    const lsaData = root.logisticsSupportAnalysisData ?? {};
    const primary = lsaData.lsaPrimaryData ?? {};
    const support = lsaData.lsaSupportingData ?? {};

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
      ? related.map((r) => r.msgRef).filter(Boolean)
      : related?.msgRef ?? null;

    return {
      msgId: get('msgId'),
      msgType: get('msgType'), // 'B' or 'U'
      msgStatus: get('msgStatus'), // 'D','P','F'
      msgDate: get('msgDate'),
      relatedMsgId,
    };
  }

  // ── collection processing ─────────────────────────────────────────────────

  _processCollection(collKey, collValue, batches) {
    if (!collValue || typeof collValue !== 'object') return;

    const recordMap = this._collectionRecords.get(collKey);
    if (recordMap) {
      let matched = false;
      for (const [recordName, entityName] of recordMap) {
        const records = this._extractRecordsByName(collValue, recordName);
        if (records.length === 0) continue;
        matched = true;
        this._processRecords(entityName, records, batches);
      }
      if (matched) return;
    }

    const entityName = this._resolveEntity(collKey);
    if (!entityName) return; // unknown collection, skip silently

    // Collection value can be:
    //   - an object with a single child key (the record element name)
    //   - directly an array of records
    //   - a single record object

    const records = this._extractRecords(collValue, entityName);
    if (records.length === 0) return;
    this._processRecords(entityName, records, batches);
  }

  _processRecords(entityName, records, batches, parentContext = null) {
    const entity = this.ir.entities.get(entityName);
    if (!entity) return;

    if (!batches.has(entityName)) {
      batches.set(entityName, { insert: [], update: [], delete: [] });
    }
    const batch = batches.get(entityName);

    for (const xmlRecord of records) {
      const crud = (xmlRecord['@_crud'] ?? 'I').toUpperCase();
      const uid = xmlRecord['@_uid'] ?? xmlRecord['@_id'] ?? null;

      if (crud === 'D') {
        if (uid) batch.delete.push(uid);
        continue;
      }

      const row = this._xmlRecordToRow(entity, xmlRecord);
      if (parentContext?.fkColumn) {
        row._xmlParent = {
          entityName: parentContext.entityName,
          uid: parentContext.uid,
          fkColumn: parentContext.fkColumn,
        };
      }

      this._attachOneToOneRelationRefs(entity, xmlRecord, row, batches);

      if (crud === 'U') {
        row._xmlUid = uid; // preserve for UPDATE WHERE uid = ?
        batch.update.push(row);
      } else {
        // 'I' or any other value → insert
        batch.insert.push(row);
      }

      this._processRecordRelations(entity, xmlRecord, batches, uid);
    }
  }

  _processRecordRelations(entity, xmlRecord, batches, parentUid) {
    for (const relation of (entity.relations || [])) {
      if (!relation.parentColumn) continue;

      const childRecords = this._extractRelationRecords(entity, xmlRecord, relation);
      if (childRecords.length === 0) continue;
      if (!parentUid) {
        throw new Error(
          `Cannot persist nested ${relation.fieldName} records for `
          + `${entity.name}: parent record has no uid`,
        );
      }

      this._processRecords(relation.targetEntity, childRecords, batches, {
        entityName: entity.name,
        uid: parentUid,
        fkColumn: relation.parentColumn,
      });
    }
  }

  _attachOneToOneRelationRefs(entity, xmlRecord, row, batches) {
    for (const relation of (entity.relations || [])) {
      if (relation.parentColumn || relation.kind !== 'one-to-one') continue;

      const childRecords = this._extractRelationRecords(entity, xmlRecord, relation);
      if (childRecords.length === 0) continue;

      const relationCol = relationColumn(entity, relation);
      if (!relationCol) continue;

      const childRecord = childRecords[0];
      const childUid = childRecord['@_uid'] ?? childRecord['@_id'] ?? null;
      if (!childUid) {
        throw new Error(
          `Cannot persist nested ${entity.name}.${relation.fieldName}: `
          + 'child record has no uid',
        );
      }

      if (!row._xmlRelations) row._xmlRelations = [];
      row._xmlRelations.push({
        entityName: relation.targetEntity,
        uid: childUid,
        fkColumn: relationCol.columnName,
      });

      if (entity.columns.some((c) => c.columnName === 'choice_type')) {
        row.choice_type = relation.fieldName;
      }

      this._processRecords(relation.targetEntity, childRecords, batches);
    }
  }

  _extractRelationRecords(entity, xmlRecord, relation) {
    if (relation.flattened) {
      return this._extractFlattenedGroupRecords(entity, xmlRecord, relation);
    }

    const raw = readField(xmlRecord, relation.fieldName, 'element')
             ?? readField(xmlRecord, relation.fieldName);
    if (raw === undefined || raw === null) return [];
    return this._objectRelationRecords(raw, `${entity.name}.${relation.fieldName}`);
  }

  _extractFlattenedGroupRecords(entity, xmlRecord, relation) {
    const helperEntity = this.ir.entities.get(relation.targetEntity);
    if (!helperEntity) return [];

    const records = [];
    for (const branch of (helperEntity.relations || [])) {
      const raw = readField(xmlRecord, branch.fieldName, 'element')
               ?? readField(xmlRecord, branch.fieldName);
      if (raw === undefined || raw === null) continue;

      const values = Array.isArray(raw) ? raw : [raw];
      for (const value of values) {
        if (value && typeof value === 'object') {
          records.push({ [branch.fieldName]: value });
        } else {
          throw new Error(
            `Unsupported XML relation shape for ${entity.name}.${branch.fieldName}: `
            + `expected object record, got ${_valueType(value)}`,
          );
        }
      }
    }

    return records;
  }

  _objectRelationRecords(raw, relationPath) {
    const values = Array.isArray(raw) ? raw : [raw];
    const records = [];
    for (const value of values) {
      if (value && typeof value === 'object') {
        records.push(value);
      } else {
        throw new Error(
          `Unsupported XML relation shape for ${relationPath}: `
          + `expected object record, got ${_valueType(value)}`,
        );
      }
    }
    return records;
  }

  _extractRecordsByName(collValue, recordName) {
    if (Array.isArray(collValue)) {
      return collValue.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        if (item[recordName] !== undefined) {
          const child = item[recordName];
          return Array.isArray(child) ? child : [child];
        }
        return item['@_uid'] !== undefined || item['@_id'] !== undefined ? [item] : [];
      });
    }
    if (!collValue || typeof collValue !== 'object') return [];

    const child = collValue[recordName];
    if (Array.isArray(child)) return child;
    if (child && typeof child === 'object') return [child];
    return [];
  }

  _extractRecords(collValue, entityName) {
    // If it's already an array, we're done
    if (Array.isArray(collValue)) return collValue;

    // If it's an object, look for the singular child key
    if (typeof collValue === 'object') {
      const singular = singularOf(entityName);
      // Try entityName and singular as child keys
      for (const key of [entityName, singular, ...Object.keys(collValue)]) {
        const child = collValue[key];
        if (child === undefined) continue;
        if (Array.isArray(child)) return child;
        if (typeof child === 'object') return [child];
      }
    }
    return [];
  }

  // ── record → DB row ───────────────────────────────────────────────────────

  _xmlRecordToRow(entity, xmlRecord) {
    const row = {};

    for (const col of entity.columns) {
      // Never map surrogate PK or technical tracking cols from XML
      if (col.columnName === 'id') continue;
      if (col.columnName.startsWith('_')) continue;
      if (!isXmlImportColumn(col)) continue;

      const raw = readColumnField(xmlRecord, col);

      if (raw === undefined) {
        row[col.columnName] = col.defaultValue !== undefined && col.defaultValue !== null
          ? col.defaultValue
          : null;
        continue;
      }

      if (col.sqlType === 'LONGTEXT' && typeof raw === 'object') {
        this._validateColumnAssertions(entity, col, raw);
        // Store the nested XML subtree as JSON string (LONGTEXT column)
        row[col.columnName] = JSON.stringify(raw);
      } else {
        row[col.columnName] = _coerce(raw, col.sqlType);
      }
    }

    return row;
  }

  _validateColumnAssertions(entity, col, raw) {
    if (!col.xsdType) return;
    const result = validateValueAssertions(this.ir, col.xsdType, raw);
    if (!result.valid) {
      const err = result.errors[0];
      throw new Error(
        `XSD assertion failed while deserializing ${entity.name}.${col.name} `
        + `as ${col.xsdType}: ${err.message}`,
      );
    }
  }
}

// ─── standalone parse helper ──────────────────────────────────────────────────

const _xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  trimValues: true,
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
