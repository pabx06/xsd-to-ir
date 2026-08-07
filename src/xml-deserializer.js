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

function _metadataValue(value, wrapperKeys = []) {
  if (value === undefined || value === null || Array.isArray(value)) return null;

  if (typeof value === 'object') {
    for (const key of wrapperKeys) {
      if (value[key] !== undefined) return _metadataValue(value[key]);
    }
    return value['#text'] !== undefined ? String(value['#text']) : null;
  }

  return String(value);
}

function _messageDateValue(value, version) {
  if (version === '1.1') return _metadataValue(value, ['dateTime']);

  if (value && typeof value === 'object' && !Array.isArray(value)
      && value.date !== undefined) {
    const date = _metadataValue(value.date);
    const time = _metadataValue(value.time);
    if (date === null) return null;
    return time === null ? date : `${date}T${time}`;
  }

  // Preserve the scalar shorthand accepted by the existing public API.
  return _metadataValue(value);
}

function _messageReferenceValue(value) {
  if (value === undefined || value === null || Array.isArray(value)) return null;
  if (typeof value !== 'object') return String(value);

  if (value.msgId !== undefined) return _metadataValue(value.msgId, ['id']);
  if (value['@_uidRef'] !== undefined) return String(value['@_uidRef']);
  if (value['@_uriRef'] !== undefined) return String(value['@_uriRef']);
  return _metadataValue(value);
}

function _relatedMessageIds(value) {
  if (value === undefined || value === null) return null;

  const relations = Array.isArray(value) ? value : [value];
  const ids = relations
    .map((relation) => _messageReferenceValue(relation?.msgRef))
    .filter((id) => id !== null);

  return Array.isArray(value) ? ids : (ids[0] ?? null);
}

// ─── Deserializer ─────────────────────────────────────────────────────────────

const S3000L_ROOT_NAMES = new Set([
  'lsaDataset', // S3000L v 2.0
  'lsaDataSet', // S3000L v 1.1
]);
const XML_SCHEMA_INSTANCE_NAMESPACE = 'http://www.w3.org/2001/XMLSchema-instance';

function _bareXmlName(name) {
  if (!name || typeof name !== 'string') return name;
  return name.includes(':') ? name.split(':').pop() : name;
}

function _findRootKey(parsed) {
  return Object.keys(parsed).find(
    (key) => S3000L_ROOT_NAMES.has(_bareXmlName(key)),
  );
}

function _hasOwn(value, key) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, key);
}

function _namespaceUri(prefix, values) {
  const declaration = `@_xmlns:${prefix}`;
  for (const value of values) {
    if (_hasOwn(value, declaration)) return String(value[declaration]);
  }
  return null;
}

function _isExplicitlyNil(value, namespaceContexts = []) {
  if (value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;

  return Object.entries(value).some(([key, rawValue]) => {
    const match = /^@_([^:]+):nil$/.exec(key);
    if (!match) return false;
    if (_namespaceUri(match[1], [value, ...namespaceContexts])
        !== XML_SCHEMA_INSTANCE_NAMESPACE) return false;
    const nilValue = String(rawValue).trim();
    return nilValue === 'true' || nilValue === '1';
  });
}

function _indexExplicitlyNilValues(root) {
  const explicitlyNil = new WeakSet();

  const walk = (value, inheritedNamespaces = new Map()) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, inheritedNamespaces);
      return;
    }
    if (value === null || typeof value !== 'object') return;

    const namespaces = new Map(inheritedNamespaces);
    for (const [key, uri] of Object.entries(value)) {
      const declaration = /^@_xmlns:([^:]+)$/.exec(key);
      if (declaration) namespaces.set(declaration[1], String(uri));
    }

    for (const [key, rawValue] of Object.entries(value)) {
      const nilAttribute = /^@_([^:]+):nil$/.exec(key);
      if (!nilAttribute) continue;
      if (namespaces.get(nilAttribute[1]) !== XML_SCHEMA_INSTANCE_NAMESPACE) continue;
      const nilValue = String(rawValue).trim();
      if (nilValue === 'true' || nilValue === '1') explicitlyNil.add(value);
    }

    for (const [key, child] of Object.entries(value)) {
      if (!key.startsWith('@_')) walk(child, namespaces);
    }
  };

  walk(root);
  return explicitlyNil;
}

function _hasElementContent(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).some((key) => !key.startsWith('@_'));
}

function _hasNonEmptyText(value) {
  if (typeof value === 'string') return value.trim() !== '';
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return true;
  return _hasOwn(value, '#text') && String(value['#text']).trim() !== '';
}

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
    const rootKey = _findRootKey(parsed);

    if (!rootKey) {
      throw new Error(
        'No S3000L root found: expected '
            + '<lsaDataSet> for version 1.1 or '
            + '<lsaDataset> for version 2.0',
      );
    }

    const root = parsed[rootKey];
    this._rootContext = root;
    this._explicitlyNilValues = _indexExplicitlyNilValues(root);
    const version = this._detectEnvelopeVersion(rootKey);
    const expectedDialect = this.ir.s3000lDialect;
    if (expectedDialect != null && expectedDialect !== version) {
      throw new Error(
        `S3000L dialect mismatch: XML is ${version} but IR expects ${expectedDialect}`,
      );
    }

    // Message metadata is located directly under the root ...
    const msgMeta = this._extractMsgMeta(root, version);

    // Normalize version-specific envelope containers.
    const { primary, support } = this._extractDataContainers(
      root,
      version,
    );

    const batches = new Map();

    for (const [collKey, collValue] of Object.entries(primary)) {
      this._processCollection(collKey, collValue, batches);
    }

    for (const [collKey, collValue] of Object.entries(support)) {
      this._processCollection(collKey, collValue, batches);
    }

    return {
      msgMeta,
      batches,
      version,
    };
  }

  // ── msg metadata ──────────────────────────────────────────────────────────

  _extractMsgMeta(root, version) {
    const get = (key, wrappers = []) => _metadataValue(root[key], wrappers);
    const statusWrappers = version === '2.0'
      ? ['state', 'code']
      : ['code', 'state'];

    return {
      msgId: get('msgId', ['id']),
      msgType: get('msgType', ['code']), // 'B' or 'U'
      msgStatus: get('msgStatus', statusWrappers), // 'D','P','F'
      msgDate: _messageDateValue(root.msgDate, version),
      relatedMsgId: _relatedMessageIds(root.relatedMsg),
    };
  }

  // ── collection processing ─────────────────────────────────────────────────

  _processCollection(collKey, collValue, batches) {
    if (!collValue || typeof collValue !== 'object') return;

    const recordMap = this._collectionRecords.get(collKey);
    if (recordMap) {
      for (const [recordName, entityName] of recordMap) {
        const records = this._extractRecordsByName(collValue, recordName);
        if (records.length === 0) continue;
        this._processRecords(entityName, records, batches);
      }
      // Collection metadata is authoritative. An empty mapped collection is
      // not itself a record and must not fall through to plural-name lookup.
      return;
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

    for (const xmlRecord of records) {
      const explicitlyNil = this._isExplicitlyNil(xmlRecord, [this._rootContext]);
      if (explicitlyNil && xmlRecord === null) continue;
      if (!xmlRecord || typeof xmlRecord !== 'object' || Array.isArray(xmlRecord)) {
        throw new Error(
          `Unsupported XML record shape for ${entityName}: `
          + `expected object record, got ${_valueType(xmlRecord)}`,
        );
      }

      const crud = (xmlRecord['@_crud'] ?? 'I').toUpperCase();
      const uid = xmlRecord['@_uid'] ?? xmlRecord['@_id'] ?? null;
      if (explicitlyNil) {
        if (_hasElementContent(xmlRecord)) {
          throw new Error(
            `Invalid nil XML record ${entityName}: `
            + 'nil records must not contain element content',
          );
        }
        const hasExplicitCrud = _hasOwn(xmlRecord, '@_crud');
        if (!uid && !hasExplicitCrud) continue;
        if (crud !== 'D') {
          throw new Error(
            `Cannot persist nil ${entityName} record with crud="${crud}": `
            + 'only uid-bearing deletes are supported',
          );
        }
      }
      const requiresUid = entity.columns.some(
        (col) => col.columnName === 'uid' && col.nullable === false,
      );

      if (requiresUid && !uid) {
        throw new Error(
          `Cannot persist ${entityName} record with crud="${crud}": `
          + 'uid is required by the generated database model',
        );
      }

      if (crud === 'D') {
        if (!uid) continue;
        if (!batches.has(entityName)) {
          batches.set(entityName, { insert: [], update: [], delete: [] });
        }
        batches.get(entityName).delete.push(uid);
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

      const hasDeleteOnlyRelation = this._attachOneToOneRelationRefs(
        entity,
        xmlRecord,
        row,
        batches,
      );
      const hasXmlColumns = entity.columns.some(isXmlImportColumn);
      if (hasDeleteOnlyRelation && !hasXmlColumns) continue;

      if (!batches.has(entityName)) {
        batches.set(entityName, { insert: [], update: [], delete: [] });
      }
      const batch = batches.get(entityName);

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
    let hasDeleteOnlyRelation = false;
    for (const relation of (entity.relations || [])) {
      if (relation.parentColumn || relation.kind !== 'one-to-one') continue;

      const childRecords = this._extractRelationRecords(entity, xmlRecord, relation);
      if (childRecords.length === 0) continue;

      const childRecord = childRecords[0];
      const childUid = childRecord['@_uid'] ?? childRecord['@_id'] ?? null;
      if (!childUid) {
        throw new Error(
          `Cannot persist nested ${entity.name}.${relation.fieldName}: `
          + 'child record has no uid',
        );
      }

      const childCrud = (childRecord['@_crud'] ?? 'I').toUpperCase();
      if (childCrud === 'D') {
        this._processRecords(relation.targetEntity, childRecords, batches);
        hasDeleteOnlyRelation = true;
        continue;
      }

      const relationCol = relationColumn(entity, relation);
      if (!relationCol) continue;

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
    return hasDeleteOnlyRelation;
  }

  _extractRelationRecords(entity, xmlRecord, relation) {
    if (relation.flattened) {
      return this._extractFlattenedGroupRecords(entity, xmlRecord, relation);
    }

    const raw = readField(xmlRecord, relation.fieldName, 'element')
             ?? readField(xmlRecord, relation.fieldName);
    if (raw === undefined || raw === null) return [];
    return this._objectRelationRecords(
      raw,
      `${entity.name}.${relation.fieldName}`,
      [xmlRecord, this._rootContext],
    );
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
        const nilAction = this._nilRelationAction(
          value,
          `${entity.name}.${branch.fieldName}`,
          [xmlRecord, this._rootContext],
        );
        if (nilAction === 'skip') continue;
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

  _objectRelationRecords(raw, relationPath, namespaceContexts = []) {
    const values = Array.isArray(raw) ? raw : [raw];
    const records = [];
    for (const value of values) {
      const nilAction = this._nilRelationAction(value, relationPath, namespaceContexts);
      if (nilAction === 'skip') continue;
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

  _isExplicitlyNil(value, namespaceContexts = []) {
    if (value === null) return true;
    if (value && typeof value === 'object'
        && this._explicitlyNilValues?.has(value)) return true;
    return _isExplicitlyNil(value, namespaceContexts);
  }

  _nilRelationAction(value, relationPath, namespaceContexts) {
    if (!this._isExplicitlyNil(value, namespaceContexts)) return 'keep';
    if (_hasElementContent(value)) {
      throw new Error(
        `Invalid nil XML relation ${relationPath}: `
        + 'nil records must not contain element content',
      );
    }

    const uid = value?.['@_uid'] ?? value?.['@_id'] ?? null;
    const hasExplicitCrud = _hasOwn(value, '@_crud');
    if (!uid && !hasExplicitCrud) return 'skip';

    const crud = (value['@_crud'] ?? 'I').toUpperCase();
    if (crud !== 'D') {
      throw new Error(
        `Cannot persist nil XML relation ${relationPath} with crud="${crud}": `
        + 'only uid-bearing deletes are supported',
      );
    }
    return 'keep';
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

  _detectEnvelopeVersion(rootKey) {
    const rootName = _bareXmlName(rootKey);
    if (rootName === 'lsaDataSet') return '1.1';
    if (rootName === 'lsaDataset') return '2.0';
    throw new Error(
      `Unsupported S3000L envelope <${rootName}>`,
    );
  }

  _extractDataContainers(root, version) {
    if (version === '1.1') {
      if (_hasOwn(root, 'logisticsSupportAnalysisData')) {
        throw new Error(
          'Invalid S3000L 1.1 <lsaDataSet> envelope: '
          + 'unexpected <logisticsSupportAnalysisData>',
        );
      }

      if (!_hasOwn(root, 'msgContent') || root.msgContent === null) {
        return { primary: {}, support: {} };
      }

      const msgContent = root.msgContent;
      if (Array.isArray(msgContent)) {
        throw new Error(
          'Invalid S3000L 1.1 <lsaDataSet> envelope: '
          + '<msgContent> must not occur more than once',
        );
      }
      if (this._isExplicitlyNil(msgContent, [root])) {
        if (_hasElementContent(msgContent)) {
          throw new Error(
            'Invalid S3000L 1.1 <msgContent>: a nil element must not contain content',
          );
        }
        return { primary: {}, support: {} };
      }

      for (const required of ['messageContentItems', 'supportingContentItems']) {
        if (!_hasOwn(msgContent, required)
            || this._isExplicitlyNil(msgContent[required], [msgContent, root])) {
          throw new Error(
            `Invalid S3000L 1.1 <msgContent>: required <${required}> `
            + 'is missing or nil',
          );
        }
      }

      return {
        primary: msgContent.messageContentItems,
        support: msgContent.supportingContentItems,
      };
    }

    if (_hasOwn(root, 'msgContent')) {
      throw new Error(
        'Invalid S3000L 2.0 <lsaDataset> envelope: unexpected <msgContent>',
      );
    }
    if (!_hasOwn(root, 'logisticsSupportAnalysisData')
        || Array.isArray(root.logisticsSupportAnalysisData)
        || this._isExplicitlyNil(root.logisticsSupportAnalysisData, [root])) {
      throw new Error(
        'Invalid S3000L 2.0 <lsaDataset> envelope: required '
        + '<logisticsSupportAnalysisData> must occur exactly once and be non-nil',
      );
    }

    const lsaData = root.logisticsSupportAnalysisData;
    if (_hasNonEmptyText(lsaData)) {
      throw new Error(
        'Invalid S3000L 2.0 <logisticsSupportAnalysisData>: '
        + 'element-only content must not contain text',
      );
    }

    return {
      primary: lsaData.lsaPrimaryData ?? {},
      support: lsaData.lsaSupportingData ?? {},
    };
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
