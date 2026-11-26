/**
 * xml-serializer.js
 *
 * Constructs an outbound Issue 1.1 or 2.0 S3000L XML message from DB rows:
 *
 *   DB rows  →  JS object tree  →  XML string
 *
 * It uses the IR to know:
 *   - Which columns map to XML attributes vs child elements
 *   - Which LONGTEXT columns contain JSON to re-expand as nested XML nodes
 *   - Which entities belong in lsaPrimaryData vs lsaSupportingData
 *
 * The IR dialect selects the envelope. Header values come from export options.
 *
 * Output modes:
 *   B (Baseline)  — all active rows, crud="I" on every record
 *   U (NetChange) — dirty rows not yet stamped by markExported(),
 *                   with per-row crud="I"|"U"|"D"
 *
 * Usage:
 *   const { XMLSerializer } = require('./xml-serializer');
 *   const s = new XMLSerializer(ir, db);
 *
 *   const xml = await s.serialize({
 *     msgType  : 'B',        // 'B' | 'U'
 *     msgStatus: 'F',        // 'D' | 'P' | 'F'
 *     since    : null,       // for 'U': enables dirty-row filtering
 *     collections: null,     // null = all; or ['tasks', 'breakdowns']
 *     msgId    : 'MSG-001',
 *   });
 */

const { XMLBuilder } = require('fast-xml-parser');
const { buildEnvelope } = require('./xml-export-envelope');
const { validateValueAssertions } = require('./assertion-validator');
const { XMLValueOrder } = require('./xml-value-order');
const {
  collectionEntries,
  columnXmlKindForExport,
  columnXmlNameForExport,
  fallbackCollectionMeta,
  relationColumn,
} = require('./s3000l-xml-metadata');

// ─── XML builder config ───────────────────────────────────────────────────────

function _makeBuilder() {
  return new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    format: true,
    indentBy: '  ',
    suppressBooleanAttributes: false,
    suppressEmptyNode: true,
  });
}

function _isBooleanColumn(col) {
  const sqlType = String(col.sqlType || '').toUpperCase();
  return col.jsonType === 'boolean'
    || sqlType === 'BOOLEAN'
    || sqlType === 'TINYINT(1)';
}

function _displayBooleanValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);

  try {
    return String(value);
  } catch {
    return '<unprintable>';
  }
}

function _canonicalBooleanXmlValue(entity, col, value) {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase()
    : value;

  if (normalized === true || normalized === 1
      || normalized === 'true' || normalized === '1') {
    return 'true';
  }
  if (normalized === false || normalized === 0
      || normalized === 'false' || normalized === '0') {
    return 'false';
  }

  const entityName = entity.name || entity.tableName || '<unknown entity>';
  const fieldName = col.name || col.xmlName || col.columnName || '<unknown field>';
  throw new TypeError(
    `Invalid boolean value while serializing ${entityName}.${fieldName}: `
    + `${_displayBooleanValue(value)} (type ${typeof value}); expected true, false, 1, or 0`,
  );
}

// ─── row → XML node ───────────────────────────────────────────────────────────

/**
 * Convert a DB row back to an XML-ready JS object using the IR entity.
 *
 * S3000L convention:
 *   - uid and crud are XML *attributes* (@_ prefix)
 *   - All other columns become child elements
 *   - LONGTEXT JSON columns are re-expanded as nested object/array children
 *
 * @param {object} entity  IR entity
 * @param {object} row     DB row
 * @param {string} crud    'I' | 'U' | 'D'
 * @param {object} context IR, DB adapter and state shared during one serialization
 */
async function _rowToXmlNode(entity, row, crud, context) {
  const { ir, valueOrder, msgType } = context;
  const key = JSON.stringify([entity.name, String(row.id)]);
  if (context.ancestors.has(key)) throw new Error(`Cyclic XML containment at ${entity.name} id ${row.id}`);
  context.ancestors.add(key);
  const record = _rememberRecord(context.records, entity, row);
  const node = _hasColumn(entity, 'crud') ? { '@_crud': crud } : {};

  for (const col of entity.columns) {
    const xmlKind = columnXmlKindForExport(col);

    // Skip internal tech cols
    if (col.columnName === 'id') continue;
    if (col.columnName.startsWith('_')) continue;
    if (xmlKind === 'internal') continue;
    if (xmlKind === 'relation') continue;
    if (col.columnName === 'crud') continue; // supplied by export mode

    const val = row[col.columnName];
    if (val === null || val === undefined) continue;

    const xmlKey = columnXmlNameForExport(col);
    const isBoolean = _isBooleanColumn(col);
    const booleanValue = isBoolean
      ? _canonicalBooleanXmlValue(entity, col, val)
      : null;

    if (xmlKind === 'attribute') {
      node[`@_${xmlKey}`] = isBoolean ? booleanValue : String(val);
      continue;
    }

    if (isBoolean) {
      node[xmlKey] = booleanValue;
    } else if (col.sqlType === 'LONGTEXT') {
      // Re-expand JSON string back into nested XML object
      let parsed = val;
      if (typeof val === 'string') {
        try {
          parsed = JSON.parse(val);
        } catch {
          node[xmlKey] = val; // fallback: leave as string
          continue;
        }
      }
      const value = msgType === 'B' ? _baselineValue(parsed, record, valueOrder, col.valueTypeRef) : parsed;
      if (value === undefined) continue;
      _validateColumnAssertions(ir, entity, col, value);
      node[xmlKey] = col.valueTypeRef ? valueOrder.complex(value, col.valueTypeRef) : value;
    } else if (col.sqlType === 'LONGBLOB') {
      // Base64-encode binary back to XML
      node[xmlKey] = Buffer.isBuffer(val)
        ? val.toString('base64')
        : String(val);
    } else {
      node[xmlKey] = String(val);
    }
  }

  await _appendRelationNodes(entity, row, node, context);
  context.ancestors.delete(key);
  // Relations and columns share a single XSD sequence.
  return valueOrder.complex(node, entity.name, false);
}

function _collectDeletedUids(value, uids) {
  if (!value || typeof value !== 'object') return;
  if (typeof value['@_uid'] === 'string') uids.push(value['@_uid']);
  Object.values(value).forEach((child) => _collectDeletedUids(child, uids));
}

// Imports from older clients can leave explicit delete nodes in inline XML JSON.
function _baselineValue(value, record, valueOrder, typeName) {
  if (Array.isArray(value)) {
    const kept = value.map((item) => _baselineValue(item, record, valueOrder, typeName))
      .filter((item) => item !== undefined);
    return value.length && !kept.length ? undefined : kept;
  }
  if (!value || typeof value !== 'object') return value;
  if (value['@_crud'] === 'D') {
    if (record) {
      if (!record.omittedDeletionUids) record.omittedDeletionUids = [];
      _collectDeletedUids(value, record.omittedDeletionUids);
    }
    return undefined;
  }
  const entries = Object.entries(value);
  const keptEntries = [];
  const shape = valueOrder.shape(typeName);
  for (const [key, child] of entries) {
    const childType = shape?.elements.get(key)?.valueTypeRef;
    const kept = _baselineValue(child, record, valueOrder, childType);
    if (kept !== undefined) keptEntries.push([key, kept]);
  }
  // An Issue 1.1 rmks wrapper, for example, must contain at least one rmk.
  if (entries.length && !keptEntries.length && !valueOrder.allowsEmpty(typeName)) return undefined;
  const copy = Object.fromEntries(keptEntries);
  if (['U', 'R', 'N'].includes(copy['@_crud'])) copy['@_crud'] = 'I';
  return copy;
}

function _rememberRecord(records, entity, row) {
  if (!records || !_hasColumn(entity, 'uid')) return null;
  const { id } = row;
  if (!(typeof id === 'string' && id.length) && !Number.isSafeInteger(id)) {
    throw new Error(`Missing or imprecise SQL primary key for exported ${entity.name}`);
  }
  const key = JSON.stringify([entity.name, String(id)]);
  if (!records.has(key)) records.set(key, { entityName: entity.name, id });
  return records.get(key);
}

async function _appendRelationNodes(entity, row, node, context) {
  const {
    ir, db, msgType, since,
  } = context;
  if (!row || row.id === undefined || row.id === null) return;

  for (const relation of (entity.relations || [])) {
    if (!ir.entities.has(relation.targetEntity)) continue;

    const childEntity = ir.entities.get(relation.targetEntity);
    const queryOpts = msgType === 'U' && since !== null ? { since } : {};

    if (!relation.parentColumn) {
      const relationCol = relationColumn(entity, relation);
      const childId = relationCol ? row[relationCol.columnName] : null;
      if (childId === null || childId === undefined) continue;

      const childRow = await _queryById(db, relation.targetEntity, childId, queryOpts);
      if (!childRow) continue;

      const childCrud = _crudForRow(childRow, msgType, since);
      const childNode = await _rowToXmlNode(childEntity, childRow, childCrud, context);
      node[relation.fieldName] = childNode;
      continue;
    }

    const childRows = await _queryRelatedRows(db, relation.targetEntity, relation.parentColumn, row.id, queryOpts);

    if (childRows.length === 0) continue;

    if (!relation.flattened && relation.kind === 'one-to-one' && childRows.length > 1) {
      throw new Error(`Multiple rows for one-to-one relation ${entity.name}.${relation.fieldName}`);
    }
    const childNodes = [];
    for (const childRow of childRows) {
      const childCrud = _crudForRow(childRow, msgType, since);
      childNodes.push(await _rowToXmlNode(childEntity, childRow, childCrud, context));
    }

    if (relation.flattened) {
      for (const childNode of childNodes) {
        _appendFlattenedNode(node, childNode);
      }
      continue;
    }

    node[relation.fieldName] = relation.kind === 'one-to-one'
      ? childNodes[0]
      : childNodes;
  }
}

function _appendFlattenedNode(target, childNode) {
  for (const [key, value] of Object.entries(childNode || {})) {
    if (key.startsWith('@_')) continue;
    const values = Array.isArray(value) ? value : [value];

    if (target[key] === undefined) {
      target[key] = Array.isArray(value) ? [...value] : value;
      continue;
    }

    if (!Array.isArray(target[key])) target[key] = [target[key]];
    target[key].push(...values);
  }
}

async function _queryRelatedRows(db, entityName, parentColumn, parentId, opts) {
  if (typeof db.queryRelated === 'function') {
    return db.queryRelated(entityName, parentColumn, parentId, opts);
  }

  const rows = await db.queryEntity(entityName, opts);
  return rows.filter((row) => String(row[parentColumn]) === String(parentId));
}

async function _queryById(db, entityName, id, opts) {
  if (typeof db.queryById === 'function') {
    return db.queryById(entityName, id, opts);
  }

  const rows = await db.queryEntity(entityName, opts);
  return rows.find((row) => String(row.id) === String(id)) || null;
}

function _hasColumn(entity, columnName) {
  return entity.columns.some((col) => col.columnName === columnName);
}

function _crudForRow(row, msgType, since) {
  if (msgType !== 'U' || since === null) return 'I';

  const created = row._created_at ? new Date(row._created_at) : null;
  const updated = row._updated_at ? new Date(row._updated_at) : null;
  return created && updated && updated > created ? 'U' : 'I';
}

function _validateColumnAssertions(ir, entity, col, value) {
  const typeName = col.valueTypeRef || col.xsdType;
  if (!typeName || value === null) return;
  const result = validateValueAssertions(ir, typeName, value);
  if (!result.valid) {
    const err = result.errors[0];
    throw new Error(
      `XSD assertion failed while serializing ${entity.name}.${col.name} `
      + `as ${typeName}: ${err.message}`,
    );
  }
}

// ─── XMLSerializer ────────────────────────────────────────────────────────────

class XMLSerializer {
  /**
   * @param {object}    ir    IR from IRBuilder.build()
   * @param {DBAdapter} db    DBAdapter instance
   */
  constructor(ir, db) {
    this.ir = ir;
    this.db = db;
    this.builder = _makeBuilder();
    this.valueOrder = new XMLValueOrder(ir);
    this.collectionMeta = collectionEntries(ir, { requireSection: true });
  }

  // ── main entry point ──────────────────────────────────────────────────────

  /**
   * Serialize DB contents to a valid S3000L XML string.
   *
   * @param {object}   opts
   * @param {string}   opts.msgType       'B' | 'U'
   * @param {string}   opts.msgStatus     'D' | 'P' | 'F'
   * @param {number|null} opts.since      For 'U': enables dirty-row filtering
   * @param {string[]|null} opts.collections  Null = all; or subset list
   * @param {string}   [opts.msgId]       Message identifier
   * @param {string|Date} [opts.msgDate] Message timestamp, defaults to the current time
   * @param {string}   [opts.relatedMsgId] For net-change: ref to baseline
   * @param {string}   [opts.sendingSystem]
   * @param {string}   [opts.receivingSystem]
   *
   * @param {string} [opts.version] Issue 1.1 or 2.0. Defaults to the IR dialect.
   * @param {boolean} [opts.includeExportedRecords] Include SQL IDs of emitted UID-bearing rows.
   * @returns {Promise<string|{xml:string,exportedRecords:Array}>}
   */
  async serialize(opts = {}) {
    const {
      msgType = 'B', since = null, collections = null, includeExportedRecords = false,
    } = opts;
    const version = opts.version ?? this.ir.s3000lDialect ?? '2.0';
    if (!['1.1', '2.0'].includes(version) || (this.ir.s3000lDialect && this.ir.s3000lDialect !== version)) {
      throw new Error(`Invalid export dialect ${version} for IR dialect ${this.ir.s3000lDialect}`);
    }
    if (!['B', 'U'].includes(msgType)) throw new Error(`Invalid export message type: ${msgType}`);
    const records = includeExportedRecords ? new Map() : null;
    const context = {
      ir: this.ir, db: this.db, valueOrder: this.valueOrder, msgType, since, records, ancestors: new Set(),
    };
    const primary = await this._buildSection('lsaPrimaryData', context, collections);
    const supporting = await this._buildSection('lsaSupportingData', context, collections);
    const xml = this.builder.build(buildEnvelope(version, { ...opts, msgType }, primary, supporting));
    return records ? { xml, exportedRecords: [...records.values()] } : xml;
  }

  // ── section builder ───────────────────────────────────────────────────────

  /**
   * Build a data section (primary or supporting) by querying each entity.
   *
   * @param {string}           sectionName 'lsaPrimaryData' | 'lsaSupportingData'
   * @param {object}           context   This serialization's options and optional record manifest
   * @param {string[]|null}    filter     Allowed collection keys (null = all)
   * @returns {object}  Object whose keys are collection names
   */
  async _buildSection(sectionName, context, filter) {
    const { msgType, since } = context;
    const section = {};
    const metas = this.collectionMeta.length > 0
      ? this.collectionMeta.filter((meta) => meta.section === sectionName)
      : [...this.ir.entities.keys()]
        .map(fallbackCollectionMeta)
        .filter((meta) => meta.section === sectionName);

    for (const meta of metas) {
      const { entityName, collectionName, recordName } = meta;

      // Apply optional collection filter
      if (filter !== null
          && !filter.includes(collectionName)
          && !filter.includes(recordName)
          && !filter.includes(entityName)) {
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
      const xmlNodes = [];
      for (const row of rows) {
        const crud = _crudForRow(row, msgType, since);
        xmlNodes.push(await _rowToXmlNode(entity, row, crud, context));
      }
      for (const row of deletedRows) {
        _rememberRecord(context.records, entity, row);
        xmlNodes.push({ '@_crud': 'D', '@_uid': row.uid });
      }

      if (xmlNodes.length > 0) {
        if (!section[collectionName]) section[collectionName] = {};
        section[collectionName][recordName] = xmlNodes;
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
 * @returns {Promise<string|{xml:string,exportedRecords:Array}>}
 */
async function serializeToXML(ir, db, opts = {}) {
  return new XMLSerializer(ir, db).serialize(opts);
}

module.exports = { XMLSerializer, serializeToXML };
