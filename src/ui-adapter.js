const { isDeepStrictEqual } = require('node:util');
const { UIModel, repeating } = require('./ui-contract');

const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const own = (value, name) => value != null && Object.hasOwn(value, name);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = (value) => (value === undefined ? undefined : structuredClone(value));
const put = (target, name, value) => Object.defineProperty(target, name, {
  value, enumerable: true, configurable: true, writable: true,
});

function textContent(value) {
  if (!object(value)) return value;
  // Parsers omit #text for an empty element carrying attributes/namespaces.
  return own(value, '#text') ? value['#text'] : '';
}

function namespaces(value, inherited = { xsi: XSI }) {
  const result = { ...inherited };
  if (object(value)) {
    for (const [name, uri] of Object.entries(value)) {
      if (name.startsWith('@_xmlns:')) put(result, name.slice(8), uri);
    }
  }
  return result;
}

function nilKeys(value, context) {
  return object(value) ? Object.keys(value).filter((name) => {
    const match = /^@_([^:]+):nil$/.exec(name);
    return match && context[match[1]] === XSI;
  }) : [];
}

function isNil(value, context) {
  return nilKeys(value, context).some((name) => ['true', '1'].includes(String(value[name]).trim()));
}

function scalar(value, use, path, writing = false) {
  if (value === null || typeof value === 'object' || value === undefined) {
    throw new Error(`${path}: expected a scalar value`);
  }
  const type = use.jsonType;
  if (type === 'string' || use.alternatives?.every((item) => item.jsonType === 'string')) {
    if (writing && typeof value !== 'string') throw new Error(`${path}: expected a UI string`);
    return String(value);
  }
  if (type === 'boolean') {
    if (writing && typeof value !== 'boolean') throw new Error(`${path}: expected a UI boolean`);
    if ([true, 1, 'true', '1'].includes(value)) return true;
    if ([false, 0, 'false', '0'].includes(value)) return false;
    throw new Error(`${path}: invalid boolean value`);
  }
  if (['integer', 'number'].includes(type)) {
    if (!['string', 'number'].includes(typeof value)) throw new Error(`${path}: expected a number or exact numeric string`);
    return value;
  }
  return value;
}

/**
 * Convert logical entities or decoded cells to per-issue UI values. Edit state is
 * opaque and stays with this adapter; send only value to the UI. This is a codec,
 * not XSD validation, relation loading, or a database transaction implementation.
 */
class UIAdapter {
  constructor(ir) {
    this.model = new UIModel(ir);
    this.ir = this.model.ir;
    this.edits = new WeakMap();
    this.bindings = new WeakMap();
  }

  _remember(original, value, details) {
    const node = { original: copy(original), clean: copy(value), ...details };
    if (value !== null && typeof value === 'object') this.bindings.set(value, node);
    return { value, node };
  }

  _document(kind, name, decoded) {
    const state = Object.freeze({});
    this.edits.set(state, { kind, name, node: decoded.node });
    return { value: decoded.value, state };
  }

  _state(kind, name, state) {
    if (state === undefined) return undefined;
    const saved = this.edits.get(state);
    if (!saved || saved.kind !== kind || saved.name !== name) {
      throw new Error('Edit state belongs to a different adapter, operation, or type');
    }
    return saved.node;
  }

  decodeValue(name, value) {
    return this._document('value', name, this._read({ valueTypeRef: name }, value, name, false));
  }

  encodeValue(name, value, state) {
    return this._write({ valueTypeRef: name }, value, this._state('value', name, state), name, false);
  }

  decodeEntity(name, value) {
    return this._document('entity', name, this._readEntity(name, value, name));
  }

  encodeEntity(name, value, state) {
    return this._writeEntity(name, value, this._state('entity', name, state), name);
  }

  _columns(name) {
    return this.model.entity(name).columns;
  }

  _relations(name) {
    return this.model.entity(name).relations;
  }

  decodeRow(name, row) {
    const logical = {};
    for (const column of this._columns(name)) {
      if (!own(row, column.columnName)) continue;
      const raw = row[column.columnName];
      const value = column.valueTypeRef && typeof raw === 'string' ? JSON.parse(raw) : raw;
      put(logical, column.name, value);
    }
    return this._document('row', name, this._readEntity(name, logical, name));
  }

  /** Returns editable SQL columns only; technical keys and relations are not written. */
  encodeRow(name, value, state) {
    if (this._relations(name).some((relation) => own(value, relation.fieldName))) {
      throw new Error(`${name}: encodeRow writes columns only; save relations separately`);
    }
    const previous = this._state('row', name, state);
    const logical = this._writeEntity(name, value, previous, name);
    const row = {};
    for (const column of this._columns(name)) {
      if (own(logical, column.name)) {
        const item = logical[column.name];
        put(row, column.columnName, column.valueTypeRef && item !== null ? JSON.stringify(item) : item);
      } else if (own(previous?.original, column.name)) {
        if (!column.nullable) throw new Error(`${name}.${column.name}: cannot remove a required column`);
        put(row, column.columnName, null);
      }
    }
    return row;
  }

  _use(column) {
    return this.model.columnUse(column);
  }

  _readEntity(name, value, path) {
    if (!object(value)) throw new Error(`${path}: expected a logical entity object`);
    const result = {};
    const children = new Map();
    const columns = this._columns(name);
    const relations = this._relations(name);
    const known = new Set([
      ...columns.map((column) => column.name), ...relations.map((relation) => relation.fieldName),
    ]);
    for (const key of Object.keys(value)) {
      if (!known.has(key)) throw new Error(`${path}.${key}: unknown logical entity field; use decodeRow for SQL rows`);
    }
    for (const column of columns) {
      if (!own(value, column.name) || value[column.name] === undefined) continue;
      if (value[column.name] === null && column.nullable) continue; // SQL NULL is absence, not xsi:nil.
      const decoded = this._readField({ ...column, type: this._use(column) }, value[column.name], `${path}.${column.name}`);
      put(result, column.name, decoded.value);
      children.set(column.name, decoded.node);
    }
    for (const relation of relations) {
      if (!own(value, relation.fieldName)) continue;
      const decoded = this._readRelation(relation, value[relation.fieldName], `${path}.${relation.fieldName}`);
      put(result, relation.fieldName, decoded.value);
      children.set(relation.fieldName, decoded.node);
    }
    return this._remember(value, result, { children, metadata: [...children.values()].some((node) => node.metadata) });
  }

  _writeEntity(name, value, previous, path) {
    if (!object(value)) throw new Error(`${path}: expected a UI entity object`);
    this._checkBinding(value, previous, path);
    if (previous && isDeepStrictEqual(value, previous.clean)) return copy(previous.original);
    const result = {};
    const columns = this._columns(name);
    const relations = this._relations(name);
    const known = new Set([
      ...columns.map((column) => column.name), ...relations.map((relation) => relation.fieldName),
    ]);
    this._checkKeys(value, known, path);
    for (const column of columns) {
      if (!own(value, column.name) || value[column.name] === undefined) continue;
      const encoded = this._writeField({ ...column, type: this._use(column) }, value[column.name], previous?.children.get(column.name), `${path}.${column.name}`);
      put(result, column.name, encoded);
    }
    for (const relation of relations) {
      if (!own(value, relation.fieldName) || value[relation.fieldName] === undefined) continue;
      const child = this._writeRelation(relation, value[relation.fieldName], previous?.children.get(relation.fieldName), `${path}.${relation.fieldName}`);
      put(result, relation.fieldName, child);
    }
    return result;
  }

  _readRelation(relation, value, path) {
    if (value === null && relation.nullable) return this._remember(null, null, {});
    const read = (item, itemPath) => this._readEntity(relation.targetEntity, item, itemPath);
    return relation.kind === 'one-to-many' ? this._readArray(value, read, path) : read(value, path);
  }

  _writeRelation(relation, value, previous, path) {
    if (value === null && relation.nullable) return null;
    const write = (item, node, itemPath) => this._writeEntity(relation.targetEntity, item, node, itemPath);
    return relation.kind === 'one-to-many' ? this._writeArray(value, previous, write, path) : write(value, previous, path);
  }

  _readField(field, value, path, context) {
    const read = (item, itemPath) => this._read(field.type, item, itemPath, field.nillable, context);
    return repeating(field.maxOccurs) ? this._readArray(value, read, path) : read(value, path);
  }

  _writeField(field, value, previous, path) {
    const write = (item, node, itemPath) => this._write(field.type, item, node, itemPath, field.nillable, field.kind === 'attribute');
    return repeating(field.maxOccurs) ? this._writeArray(value, previous, write, path) : write(value, previous, path);
  }

  _readArray(value, read, path) {
    const items = Array.isArray(value) ? value : [value];
    const decoded = items.map((item, index) => read(item, `${path}[${index}]`));
    return this._remember(value, decoded.map((item) => item.value), {
      items: decoded.map((item) => item.node), metadata: decoded.some((item) => item.node.metadata),
    });
  }

  _writeArray(value, previous, write, path) {
    if (!Array.isArray(value)) throw new Error(`${path}: repeatable UI fields must be arrays`);
    this._checkBinding(value, previous, path);
    if (previous && isDeepStrictEqual(value, previous.clean)) return copy(previous.original);
    const old = previous?.items || [];
    const used = new Set();
    const matches = value.map((item) => {
      const identity = object(item) ? this.bindings.get(item) : null;
      let candidates = old.filter((node) => !used.has(node) && node === identity);
      if (!candidates.length && object(item) && item.uid !== undefined) {
        candidates = old.filter((node) => !used.has(node) && node.clean?.uid === item.uid);
      }
      if (!candidates.length) candidates = old.filter((node) => !used.has(node) && isDeepStrictEqual(node.clean, item));
      if (candidates.length > 1 && candidates.some((node) => node.metadata)) {
        throw new Error(`${path}: ambiguous duplicate values with XML metadata; retain the decoded item objects while editing`);
      }
      const match = candidates[0];
      if (match) used.add(match);
      return match;
    });
    const remaining = old.filter((node) => !used.has(node));
    const unmatched = matches.map((match, index) => (match ? -1 : index)).filter((index) => index !== -1);
    if (remaining.length && unmatched.length) {
      // A single uid-less edit is unambiguous after matching unchanged/reordered siblings.
      const index = unmatched[0];
      if (remaining.length === 1 && unmatched.length === 1
          && !own(remaining[0].clean, 'uid') && !own(value[index], 'uid')) matches[index] = remaining[0];
      else if (remaining.some((node) => node.metadata && !own(node.clean, 'uid'))
          && unmatched.some((i) => !own(value[i], 'uid'))) {
        throw new Error(`${path}: cannot safely match edited items to XML metadata; retain the decoded item objects while editing`);
      }
    }
    const encoded = value.map((item, index) => write(item, matches[index], `${path}[${index}]`));
    // Retain an original singleton shape when possible; new collections use arrays.
    return previous && !Array.isArray(previous.original) && encoded.length === 1 ? encoded[0] : encoded;
  }

  _read(use, value, path, allowNil, inherited) {
    const context = namespaces(value, inherited);
    if (isNil(value, context)) {
      if (!allowNil) throw new Error(`${path}: explicit nil is not allowed here`);
      return this._remember(value, null, { context, nil: true, metadata: true });
    }
    if (use.valueTypeRef) return this._readComplex(use.valueTypeRef, value, path, context);
    if (object(value)) {
      for (const key of Object.keys(value)) {
        if (key !== '#text' && !key.startsWith('@_')) throw new Error(`${path}.${key}: unexpected content in a scalar`);
      }
    }
    const text = textContent(value);
    const clean = scalar(text, use, path);
    return this._remember(value, clean, { context, metadata: object(value) && Object.keys(value).some((key) => key.startsWith('@_')) });
  }

  _readComplex(name, value, path, context) {
    const shape = this.model.shape(name);
    if (shape.mixed || shape.unsupported.some((reason) => /xs:any/.test(reason))) {
      throw new Error(`${path}: mixed or wildcard XML requires a dedicated UI adapter`);
    }
    if (shape.scalarText) return this._read(shape.text, value, path, false, context);
    if (!object(value) && !shape.text) throw new Error(`${path}: expected an object for ${name}`);
    const result = {};
    const children = new Map();
    const known = new Set([...shape.fields, ...shape.attributes].map((field) => field.jsonName));
    if (object(value)) {
      for (const key of Object.keys(value)) {
        if (!known.has(key) && !key.startsWith('@_') && key !== '#text') throw new Error(`${path}.${key}: unknown XML element`);
      }
    }
    for (const field of [...shape.fields, ...shape.attributes]) {
      if (!own(value, field.jsonName)) continue;
      const decoded = this._readField(field, value[field.jsonName], `${path}.${field.uiName}`, context);
      put(result, field.uiName, decoded.value);
      children.set(field.uiName, decoded.node);
    }
    if (shape.text) {
      const decoded = this._read(shape.text, textContent(value), `${path}.${shape.textName}`, false, context);
      put(result, shape.textName, decoded.value);
      children.set(shape.textName, decoded.node);
    }
    return this._remember(value, result, {
      context, children,
      metadata: (object(value) && Object.keys(value).some((key) => key.startsWith('@_') && !known.has(key)))
        || [...children.values()].some((node) => node.metadata),
    });
  }

  _checkKeys(value, known, path) {
    for (const key of Object.keys(value)) {
      if (!known.has(key)) throw new Error(`${path}.${key}: unknown UI field`);
    }
  }

  _checkBinding(value, previous, path) {
    const bound = value !== null && typeof value === 'object' ? this.bindings.get(value) : null;
    if (bound?.metadata && bound !== previous) {
      throw new Error(`${path}: XML metadata belongs to a different edit location; retain the matching edit state and use explicit edits for moves between fields`);
    }
  }

  _attributes(previous, clearNil = false) {
    const original = previous?.original;
    const result = Object.fromEntries(object(original) ? Object.entries(original).filter(([name]) => name.startsWith('@_')) : []);
    for (const name of nilKeys(result, previous?.context || namespaces(result))) {
      if (clearNil || ['true', '1'].includes(String(result[name]).trim())) delete result[name];
    }
    return result;
  }

  _write(use, value, previous, path, allowNil, attribute = false) {
    this._checkBinding(value, previous, path);
    if (previous && isDeepStrictEqual(value, previous.clean)) return copy(previous.original);
    if (value === null) {
      if (!allowNil) throw new Error(`${path}: null requires a nillable XML element`);
      const result = this._attributes(previous, true);
      if (use.valueTypeRef) {
        const attributes = this.model.shape(use.valueTypeRef).attributes;
        for (const field of attributes) {
          if (field.minOccurs > 0 && !own(result, field.jsonName)) {
            throw new Error(`${path}: creating nil requires attribute ${field.uiName}; edit an existing value with that attribute first`);
          }
        }
      }
      put(result, '@_xmlns:xsi', XSI);
      put(result, '@_xsi:nil', 'true');
      return result;
    }
    if (use.valueTypeRef) return this._writeComplex(use.valueTypeRef, value, previous, path);
    const clean = scalar(value, use, path, true);
    if (attribute) return String(clean);
    const attributes = this._attributes(previous);
    if (object(previous?.original) || Object.keys(attributes).length) return { ...attributes, '#text': clean };
    return clean;
  }

  _writeComplex(name, value, previous, path) {
    const shape = this.model.shape(name);
    if (shape.mixed || shape.unsupported.some((reason) => /xs:any/.test(reason))) {
      throw new Error(`${path}: mixed or wildcard XML requires a dedicated UI adapter`);
    }
    if (shape.scalarText) return this._write(shape.text, value, previous, path, false);
    if (!object(value)) throw new Error(`${path}: expected a UI object for ${name}`);
    const known = new Set([...shape.fields, ...shape.attributes].map((field) => field.uiName));
    if (shape.text) known.add(shape.textName);
    this._checkKeys(value, known, path);
    const result = this._attributes(previous);
    for (const field of [...shape.fields, ...shape.attributes]) {
      delete result[field.jsonName];
      if (!own(value, field.uiName) || value[field.uiName] === undefined) continue;
      const child = this._writeField(field, value[field.uiName], previous?.children?.get(field.uiName), `${path}.${field.uiName}`);
      put(result, field.jsonName, child);
    }
    if (shape.text) {
      put(result, '#text', this._write(shape.text, value[shape.textName], previous?.children?.get(shape.textName), `${path}.${shape.textName}`, false));
    }
    return result;
  }
}

module.exports = { UIAdapter };
