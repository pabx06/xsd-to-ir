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
 *   - Which LONGTEXT columns contain JSON to re-expand as nested XML nodes
 *   - Which entities belong in lsaPrimaryData vs lsaSupportingData
 *
 * The envelope nodes (lsaDataset, logisticsSupportAnalysisData,
 * lsaPrimaryData, lsaSupportingData) are never stored in the DB —
 * they are always reconstructed here.
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
const { validateValueAssertions } = require('./assertion-validator');
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
 */
async function _rowToXmlNode(entity, row, crud, ir, db, msgType, since) {
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
      _validateColumnAssertions(ir, entity, col, parsed);
      node[xmlKey] = parsed;
    } else if (col.sqlType === 'LONGBLOB') {
      // Base64-encode binary back to XML
      node[xmlKey] = Buffer.isBuffer(val)
        ? val.toString('base64')
        : String(val);
    } else {
      node[xmlKey] = String(val);
    }
  }

  await _appendRelationNodes(entity, row, node, ir, db, msgType, since);
  return node;
}

async function _appendRelationNodes(entity, row, node, ir, db, msgType, since) {
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
      node[relation.fieldName] = await _rowToXmlNode(childEntity, childRow, childCrud, ir, db, msgType, since);
      continue;
    }

    const childRows = await _queryRelatedRows(db, relation.targetEntity, relation.parentColumn, row.id, queryOpts);

    if (childRows.length === 0) continue;

    const childNodes = await Promise.all(childRows.map((childRow) => {
      const childCrud = _crudForRow(childRow, msgType, since);
      return _rowToXmlNode(childEntity, childRow, childCrud, ir, db, msgType, since);
    }));

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
  if (!col.xsdType || value === null || typeof value !== 'object') return;
  const result = validateValueAssertions(ir, col.xsdType, value);
  if (!result.valid) {
    const err = result.errors[0];
    throw new Error(
      `XSD assertion failed while serializing ${entity.name}.${col.name} `
      + `as ${col.xsdType}: ${err.message}`,
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
   * @param {string}   [opts.relatedMsgId] For net-change: ref to baseline
   * @param {string}   [opts.sendingSystem]
   * @param {string}   [opts.receivingSystem]
   *
   * @returns {string}  Well-formed XML string
   */
  async serialize(opts = {}) {
    const {
      msgType = 'B',
      msgStatus = 'F',
      since = null,
      collections = null,
      msgId = `MSG-${Date.now()}`,
      relatedMsgId = null,
      sendingSystem = null,
      receivingSystem = null,
    } = opts;

    const primaryData = await this._buildSection('lsaPrimaryData', msgType, since, collections);

    const supportingData = await this._buildSection('lsaSupportingData', msgType, since, collections);

    // ── 3. Build the envelope tree ────────────────────────────────────────
    const now = new Date().toISOString();
    const msgDate = now.split('T')[0];

    const envelope = {
      '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
      lsaDataset: {
        msgId,
        msgDate,
        msgType: { code: msgType },
        msgStatus: { code: msgStatus },

        // Optional header fields
        ...(sendingSystem ? {
          msgPty: [
            { partyType: { code: 'SE' }, partyName: sendingSystem },
            { partyType: { code: 'RE' }, partyName: receivingSystem ?? '' },
          ],
        } : {}),

        // Link to baseline for net-change messages
        ...(relatedMsgId ? {
          relatedMsg: {
            relType: { code: 'RM' },
            msgRef: relatedMsgId,
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
   * @param {string}           sectionName 'lsaPrimaryData' | 'lsaSupportingData'
   * @param {string}           msgType    'B' | 'U'
   * @param {number|null}      since
   * @param {string[]|null}    filter     Allowed collection keys (null = all)
   * @returns {object}  Object whose keys are collection names
   */
  async _buildSection(sectionName, msgType, since, filter) {
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
      const activeNodes = await Promise.all(rows.map((row) => {
        const crud = _crudForRow(row, msgType, since);
        return _rowToXmlNode(entity, row, crud, this.ir, this.db, msgType, since);
      }));

      const xmlNodes = [
        ...activeNodes,
        ...deletedRows.map((row) => ({
          '@_crud': 'D',
          '@_uid': row.uid,
        })),
      ];

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
 * @returns {Promise<string>}
 */
async function serializeToXML(ir, db, opts = {}) {
  return new XMLSerializer(ir, db).serialize(opts);
}

module.exports = { XMLSerializer, serializeToXML };
