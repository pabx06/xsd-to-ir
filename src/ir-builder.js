'use strict';

/**
 * ir-builder.js
 *
 * Walks the namespace-stripped parsed-XSD tree and produces an
 * Intermediate Representation (IR) that is the single source-of-truth
 * for both the DB-schema generator and the JSON-schema generator.
 *
 * IR shape (TypeScript-style pseudo-types for documentation):
 *
 * IRModel {
 *   entities   : Map<string, IREntity>
 *   joinTables : Map<string, IRJoinTable>
 *   enums      : Map<string, IREnum>
 *   simpleTypes: Map<string, IRSimpleType>
 * }
 *
 * IREntity {
 *   name        : string          // PascalCase type / element name
 *   tableName   : string          // snake_case DB table name
 *   columns     : IRColumn[]
 *   relations   : IRRelation[]
 *   abstract    : boolean
 *   parentType  : string | null   // xs:extension base
 *   documentation: string | null
 * }
 *
 * IRColumn {
 *   name         : string        // camelCase attribute / element name
 *   columnName   : string        // snake_case DB column name
 *   sqlType      : string
 *   jsonType     : string | object
 *   nullable     : boolean
 *   isPrimaryKey : boolean
 *   isForeignKey : boolean
 *   referencesEntity : string | null
 *   isEnum       : boolean
 *   enumRef      : string | null
 *   constraints  : object        // minLength, maxLength, pattern, enum[], etc.
 *   documentation: string | null
 * }
 *
 * IRRelation {
 *   kind          : 'one-to-many' | 'many-to-many' | 'one-to-one' | 'idrefs'
 *   fieldName     : string
 *   targetEntity  : string
 *   joinTable     : string | null   // for many-to-many
 *   nullable      : boolean
 *   minOccurs     : number
 *   maxOccurs     : number | 'unbounded'
 * }
 *
 * IRJoinTable {
 *   name          : string
 *   tableName     : string
 *   leftEntity    : string
 *   leftColumn    : string
 *   rightEntity   : string
 *   rightColumn   : string
 * }
 *
 * IREnum { name, tableName, values: string[] }
 * IRSimpleType { name, sqlType, jsonType, constraints }
 */

const { TypeResolver } = require('./type-resolver');

// ─── naming helpers ───────────────────────────────────────────────────────────

const toSnake  = s => s
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
  .replace(/([a-z\d])([A-Z])/g,    '$1_$2')
  .replace(/-/g, '_')
  .toLowerCase();

const toCamel  = s => s.replace(/[-_](.)/g, (_, c) => c.toUpperCase());
const toPascal = s => { const c = toCamel(s); return c[0].toUpperCase() + c.slice(1); };

// ─── IR builder ───────────────────────────────────────────────────────────────

class IRBuilder {
  constructor(schema) {
    this.schema   = schema;
    this.resolver = new TypeResolver(schema);

    /** @type {Map<string, object>} */
    this.entities    = new Map();
    /** @type {Map<string, object>} */
    this.joinTables  = new Map();
    /** @type {Map<string, object>} */
    this.enums       = new Map();
    /** @type {Map<string, object>} */
    this.simpleTypes = new Map();

    // Guard against infinite recursion on self-referencing types
    this._visited = new Set();
  }

  // ── entry point ────────────────────────────────────────────────────────────

  build() {
    // 1. Collect all named simpleTypes (enumerations + restrictions)
    for (const st of (this.schema.simpleType || [])) {
      this._processSimpleType(st);
    }

    // 2. Identify S3000L "real entities" — complexTypes that carry both
    //    uid AND crud attributes.  When such a set exists we restrict
    //    entity generation to that list so envelope/wrapper types are
    //    never turned into DB tables.
    const s3000lRealTypes = this._detectS3000LEntities();
    this._s3000lMode = s3000lRealTypes !== null;
    this._s3000lSet  = s3000lRealTypes ?? new Set();

    // 3. Collect all named complexTypes → entities
    for (const ct of (this.schema.complexType || [])) {
      const name = ct['@_name'];
      if (!name) continue;
      // In S3000L mode skip types that are not real entities
      if (this._s3000lMode && !this._s3000lSet.has(name)) continue;
      this._processComplexType(name, ct);
    }

    // 4. Top-level element declarations that are not just references
    for (const el of (this.schema.element || [])) {
      if (el['@_name'] && el.complexType) {
        const name = toPascal(el['@_name']);
        if (this._s3000lMode && !this._s3000lSet.has(name)) continue;
        for (const anonCT of (el.complexType || [])) {
          this._processComplexType(name, anonCT);
        }
      }
    }

    return {
      entities   : this.entities,
      joinTables : this.joinTables,
      enums      : this.enums,
      simpleTypes: this.simpleTypes,
      s3000lMode : this._s3000lMode,
    };
  }

  /**
   * Detect whether this schema uses the S3000L uid+crud pattern.
   * Returns a Set of type names that have both attributes, or null if
   * the pattern is absent (non-S3000L schema).
   */
  _detectS3000LEntities() {
    const candidates = [];
    for (const ct of (this.schema.complexType || [])) {
      const name = ct['@_name'];
      if (!name) continue;
      const attrs = this._flatAttributes(ct);
      const hasUid  = attrs.some(a => a['@_name'] === 'uid');
      const hasCrud = attrs.some(a => a['@_name'] === 'crud');
      if (hasUid && hasCrud) candidates.push(name);
    }
    return candidates.length > 0 ? new Set(candidates) : null;
  }

  /** Collect all attribute nodes shallowly in a complexType (not nested). */
  _flatAttributes(ct) {
    const attrs = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      for (const a of (node.attribute || [])) attrs.push(a);
      for (const cc of (node.complexContent || [])) walk(cc);
      for (const sc of (node.simpleContent  || [])) walk(sc);
      for (const ext of (node.extension     || [])) walk(ext);
      for (const res of (node.restriction   || [])) walk(res);
    };
    walk(ct);
    return attrs;
  }

  // ── simpleType processing ──────────────────────────────────────────────────

  _processSimpleType(st) {
    const name = st['@_name'];
    if (!name) return;

    const restriction = (st.restriction || [])[0];
    if (!restriction) return;

    const enumerations = (restriction.enumeration || []).map(e => e['@_value']).filter(Boolean);
    if (enumerations.length > 0) {
      // It's an enum
      this.enums.set(name, {
        name,
        tableName: toSnake(name),
        values   : enumerations,
        docs     : _docs(st),
      });
    } else {
      // It's a restricted primitive
      const base  = restriction['@_base'] || 'string';
      const prim  = this.resolver.primitiveInfo(base) || { sqlType: 'TEXT', jsonType: 'string' };
      this.simpleTypes.set(name, {
        name,
        sqlType    : prim.sqlType,
        jsonType   : prim.jsonType,
        constraints: _extractConstraints(restriction),
        docs       : _docs(st),
      });
    }
  }

  // ── complexType → entity ───────────────────────────────────────────────────

  _processComplexType(name, ct) {
    if (this._visited.has(name)) return;
    // In S3000L mode: only materialise real entities (uid+crud types).
    // Types referenced from within a real entity but not in the set are
    // flattened inline or treated as opaque columns — NOT separate tables.
    if (this._s3000lMode && !this._s3000lSet.has(name)) return;
    this._visited.add(name);

    const entity = {
      name,
      tableName    : toSnake(name),
      columns      : [],
      relations    : [],
      abstract     : ct['@_abstract'] === 'true',
      parentType   : null,
      documentation: _docs(ct),
    };

    // Always add a surrogate PK (MariaDB: BIGINT AUTO_INCREMENT)
    entity.columns.push({
      name        : 'id',
      columnName  : 'id',
      sqlType     : 'BIGINT',
      jsonType    : 'integer',
      nullable    : false,
      isPrimaryKey: true,
      isForeignKey: false,
      referencesEntity: null,
      isEnum      : false,
      enumRef     : null,
      constraints : {},
      documentation: 'Surrogate primary key',
    });

    // S3000L technical tracking columns (added once per real entity)
    if (this._s3000lMode) {
      for (const col of _s3000lTechColumns()) {
        entity.columns.push(col);
      }
    }

    // Handle xs:extension (inheritance)
    const extension = _dig(ct, 'complexContent', 'extension')
                   || _dig(ct, 'simpleContent',  'extension');
    if (extension) {
      const base = extension['@_base'];
      entity.parentType = base;
      // Add FK to parent table
      entity.columns.push({
        name        : toCamel(base) + 'Id',
        columnName  : toSnake(base) + '_id',
        sqlType     : 'BIGINT',
        jsonType    : 'integer',
        nullable    : false,
        isPrimaryKey: false,
        isForeignKey: true,
        referencesEntity: base,
        isEnum      : false,
        enumRef     : null,
        constraints : {},
        documentation: `FK to parent type ${base}`,
      });
      // Ensure parent entity is processed first
      const parentCT = this.resolver.getComplexType(base);
      if (parentCT && !this._visited.has(base)) {
        this._processComplexType(base, parentCT);
      }
      this._processParticle(entity, extension);
    }

    // Handle xs:restriction
    const restriction = _dig(ct, 'complexContent', 'restriction');
    if (restriction) {
      this._processParticle(entity, restriction);
    }

    // Direct content (sequence / choice / all / attributes)
    this._processParticle(entity, ct);

    this.entities.set(name, entity);
  }

  // ── particle walker: sequence / choice / all / attributes ─────────────────

  _processParticle(entity, node) {
    if (!node) return;

    // xs:sequence and xs:all are treated identically
    for (const seqType of ['sequence', 'all']) {
      for (const seq of (node[seqType] || [])) {
        this._walkSequence(entity, seq, false);
      }
    }

    // xs:choice — all branches become nullable; add discriminator column
    for (const choice of (node.choice || [])) {
      this._walkChoice(entity, choice);
    }

    // xs:attribute declarations
    for (const attr of (node.attribute || [])) {
      this._processAttribute(entity, attr);
    }

    // xs:attributeGroup refs
    for (const ag of (node.attributeGroup || [])) {
      const ref  = ag['@_ref'];
      const agDef = ref ? this.resolver.getAttributeGroup(ref) : null;
      if (agDef) this._processParticle(entity, agDef);
    }

    // xs:group refs — walk the *inner* particle of the named group definition,
    // not the group node itself (which has no direct element children).
    // A group definition looks like:
    //   <xs:group name="Foo">
    //     <xs:sequence> ... </xs:sequence>   ← this is what we need to walk
    //   </xs:group>
    // We also respect the ref's own minOccurs/maxOccurs: if the ref says
    // maxOccurs="unbounded" we must honour that for every element inside.
    for (const g of (node.group || [])) {
      const ref     = g['@_ref'];
      const gDef    = ref ? this.resolver.getGroup(ref) : null;
      if (!gDef) continue;

      const refMin = _parseOccurs(g['@_minOccurs'], 1);
      const refMax = _parseOccurs(g['@_maxOccurs'], 1);

      if (refMax === 'unbounded' || refMax > 1) {
        // The whole group is repeating → treat it as a virtual child entity
        // so the one-to-many relationship is preserved.
        this._walkGroupAsRelation(entity, ref, gDef, refMin, refMax);
      } else {
        // Inline: flatten the group's content into the current entity
        this._walkGroupInline(entity, gDef);
      }
    }
  }

  /**
   * Flatten a named group's content into the current entity.
   * A <xs:group> wrapper holds exactly one of: sequence | choice | all.
   */
  _walkGroupInline(entity, gDef) {
    for (const seq of (gDef.sequence || [])) {
      this._walkSequence(entity, seq, false);
    }
    for (const all of (gDef.all || [])) {
      this._walkSequence(entity, all, false);   // <all> behaves like <sequence> for our purposes
    }
    for (const choice of (gDef.choice || [])) {
      this._walkChoice(entity, choice);
    }
    // A group can also carry attributes (unusual but legal)
    for (const attr of (gDef.attribute || [])) {
      this._processAttribute(entity, attr);
    }
    for (const ag of (gDef.attributeGroup || [])) {
      const ref   = ag['@_ref'];
      const agDef = ref ? this.resolver.getAttributeGroup(ref) : null;
      if (agDef) this._processParticle(entity, agDef);
    }
  }

  /**
   * A repeating group ref (maxOccurs > 1 or unbounded) is modelled as a
   * synthetic child entity containing the group's fields, related back to
   * the parent via a one-to-many.
   */
  _walkGroupAsRelation(entity, groupName, gDef, minOccurs, maxOccurs) {
    const childName = toPascal(entity.name + '_' + toPascal(groupName));
    if (!this.entities.has(childName)) {
      // Build the synthetic entity
      const child = {
        name         : childName,
        tableName    : toSnake(childName),
        columns      : [
          _surrogateKey(),
          {
            name        : toCamel(entity.name) + 'Id',
            columnName  : toSnake(entity.name) + '_id',
            sqlType     : 'BIGINT',
            jsonType    : 'integer',
            nullable    : false,
            isPrimaryKey: false,
            isForeignKey: true,
            referencesEntity: entity.name,
            isEnum      : false,
            enumRef     : null,
            constraints : {},
            documentation: `FK back to ${entity.name} (from group ${groupName})`,
          },
        ],
        relations    : [],
        abstract     : false,
        parentType   : null,
        documentation: `Synthetic entity for repeated xs:group "${groupName}" in ${entity.name}`,
      };
      this.entities.set(childName, child);
      // Now populate the child with the group's inner content
      this._walkGroupInline(child, gDef);
    }
    entity.relations.push({
      kind        : 'one-to-many',
      fieldName   : groupName,
      targetEntity: childName,
      joinTable   : null,
      nullable    : minOccurs === 0,
      minOccurs,
      maxOccurs,
    });
  }

  _walkSequence(entity, seq, insideChoice) {
    for (const el of (seq.element || [])) {
      this._processElement(entity, el, insideChoice);
    }
    for (const inner of (seq.sequence || [])) {
      this._walkSequence(entity, inner, insideChoice);
    }
    for (const all of (seq.all || [])) {
      this._walkSequence(entity, all, insideChoice);
    }
    for (const choice of (seq.choice || [])) {
      this._walkChoice(entity, choice);
    }
    for (const attr of (seq.attribute || [])) {
      this._processAttribute(entity, attr);
    }
    // xs:group refs inside a sequence
    for (const g of (seq.group || [])) {
      const ref  = g['@_ref'];
      const gDef = ref ? this.resolver.getGroup(ref) : null;
      if (!gDef) continue;
      const refMin = _parseOccurs(g['@_minOccurs'], 1);
      const refMax = _parseOccurs(g['@_maxOccurs'], 1);
      if (refMax === 'unbounded' || refMax > 1) {
        this._walkGroupAsRelation(entity, ref, gDef, refMin, refMax);
      } else {
        this._walkGroupInline(entity, gDef);
      }
    }
    // xs:attributeGroup refs inside a sequence
    for (const ag of (seq.attributeGroup || [])) {
      const ref   = ag['@_ref'];
      const agDef = ref ? this.resolver.getAttributeGroup(ref) : null;
      if (agDef) this._processParticle(entity, agDef);
    }
  }

  _walkChoice(entity, choice) {
    const elementBranches = (choice.element || []);
    const groupBranches   = (choice.group   || []);

    // Build discriminator values from both element names and group refs
    const allBranchNames = [
      ...elementBranches.map(b => b['@_name']).filter(Boolean),
      ...groupBranches.map(b => b['@_ref']).filter(Boolean),
    ];

    // Add choice_type discriminator only once per entity (avoid duplicates
    // when there are multiple xs:choice blocks in the same complexType)
    const alreadyHasDiscriminator = entity.columns.some(c => c.columnName === 'choice_type');
    if (allBranchNames.length > 1 && !alreadyHasDiscriminator) {
      entity.columns.push({
        name        : 'choiceType',
        columnName  : 'choice_type',
        sqlType     : 'VARCHAR(64)',
        jsonType    : 'string',
        nullable    : true,
        isPrimaryKey: false,
        isForeignKey: false,
        referencesEntity: null,
        isEnum      : false,
        enumRef     : null,
        constraints : { enum: allBranchNames },
        documentation: 'Discriminator for xs:choice',
      });
    }

    // Element branches are all nullable (only one fires at runtime)
    for (const el of elementBranches) {
      this._processElement(entity, el, true);
    }

    // Group branches inside a choice: flatten inline (each branch nullable)
    for (const g of groupBranches) {
      const ref  = g['@_ref'];
      const gDef = ref ? this.resolver.getGroup(ref) : null;
      if (!gDef) continue;
      const refMax = _parseOccurs(g['@_maxOccurs'], 1);
      if (refMax === 'unbounded' || refMax > 1) {
        this._walkGroupAsRelation(entity, ref, gDef, 0, refMax);
      } else {
        this._walkGroupInline(entity, gDef);
      }
    }

    // Nested sequences within choice
    for (const seq of (choice.sequence || [])) {
      this._walkSequence(entity, seq, true);
    }
    // Nested choices within choice
    for (const inner of (choice.choice || [])) {
      this._walkChoice(entity, inner);
    }
  }

  // ── element processing ─────────────────────────────────────────────────────

  _processElement(entity, el, nullable = false) {
    const elName    = el['@_name'];
    const elRef     = el['@_ref'];
    const typeName  = el['@_type'];
    const minOccurs = _parseOccurs(el['@_minOccurs'], 1);
    const maxOccurs = _parseOccurs(el['@_maxOccurs'], 1);

    const effectiveName = elName || elRef;
    if (!effectiveName) return;

    const isOptional  = nullable || minOccurs === 0;
    const isRepeating = maxOccurs === 'unbounded' || maxOccurs > 1;

    // ── inline anonymous complexType ─────────────────────────────────────────
    const anonCTs = el.complexType || [];
    if (anonCTs.length > 0) {
      const anonName = toPascal(entity.name + '_' + toPascal(effectiveName));
      for (const anonCT of anonCTs) {
        this._processComplexType(anonName, anonCT);
      }
      this._addRelation(entity, effectiveName, anonName, isOptional, minOccurs, maxOccurs);
      return;
    }

    // ── ref to another element (no type attribute) ───────────────────────────
    if (elRef && !typeName) {
      const refName = toPascal(elRef);
      // We assume the ref resolves to a complex type entity
      this._addRelation(entity, elRef, refName, isOptional, minOccurs, maxOccurs);
      return;
    }

    // ── typed element ────────────────────────────────────────────────────────
    if (typeName) {
      const resolved = this.resolver.resolve(typeName);

      if (resolved.kind === 'primitive') {
        if (isRepeating) {
          // Repeated primitive → child table (e.g. a list of codes)
          const childName = toPascal(entity.name + '_' + toPascal(effectiveName));
          if (!this.entities.has(childName)) {
            this.entities.set(childName, {
              name         : childName,
              tableName    : toSnake(childName),
              columns      : [
                _surrogateKey(),
                {
                  name        : toCamel(entity.name) + 'Id',
                  columnName  : toSnake(entity.name) + '_id',
                  sqlType     : 'BIGINT',
                  jsonType    : 'integer',
                  nullable    : false,
                  isPrimaryKey: false,
                  isForeignKey: true,
                  referencesEntity: entity.name,
                  isEnum      : false,
                  enumRef     : null,
                  constraints : {},
                  documentation: `FK back to ${entity.name}`,
                },
                {
                  name        : 'value',
                  columnName  : 'value',
                  sqlType     : resolved.sqlType,
                  jsonType    : resolved.jsonType,
                  nullable    : false,
                  isPrimaryKey: false,
                  isForeignKey: false,
                  referencesEntity: null,
                  isEnum      : false,
                  enumRef     : null,
                  constraints : {},
                  documentation: null,
                },
              ],
              relations    : [],
              abstract     : false,
              parentType   : null,
              documentation: `Repeated ${typeName} values for ${entity.name}.${effectiveName}`,
            });
          }
          entity.relations.push({
            kind        : 'one-to-many',
            fieldName   : effectiveName,
            targetEntity: childName,
            joinTable   : null,
            nullable    : isOptional,
            minOccurs,
            maxOccurs,
          });
        } else {
          // Simple scalar column
          entity.columns.push({
            name        : toCamel(effectiveName),
            columnName  : toSnake(effectiveName),
            sqlType     : resolved.sqlType,
            jsonType    : resolved.jsonType,
            nullable    : isOptional,
            isPrimaryKey: false,
            isForeignKey: resolved.isIdRef  || false,
            referencesEntity: resolved.isIdRef ? null : null, // resolved later if needed
            isEnum      : false,
            enumRef     : null,
            constraints : {
              ...(resolved.minimum  != null ? { minimum:  resolved.minimum  } : {}),
              ...(resolved.maximum  != null ? { maximum:  resolved.maximum  } : {}),
              ...(resolved.format   != null ? { format:   resolved.format   } : {}),
              ...(resolved.isId    ? { isId:    true } : {}),
              ...(resolved.isIdRef ? { isIdRef: true } : {}),
              ...(resolved.isIdRefs? { isIdRefs:true } : {}),
            },
            documentation: _docs(el),
          });

          // IDREFS → join table
          if (resolved.isIdRefs) {
            const joinName = `${entity.tableName}__${toSnake(effectiveName)}`;
            this.joinTables.set(joinName, {
              name       : joinName,
              tableName  : joinName,
              leftEntity : entity.name,
              leftColumn : toSnake(entity.name) + '_id',
              rightEntity: toPascal(effectiveName),   // best guess; override manually
              rightColumn: toSnake(effectiveName) + '_id',
              documentation: `Join table for IDREFS ${entity.name}.${effectiveName}`,
            });
          }
        }
        return;
      }

      if (resolved.kind === 'simple') {
        // Check if it's an enum
        const enumDef = this.enums.get(typeName);
        if (enumDef) {
          entity.columns.push({
            name        : toCamel(effectiveName),
            columnName  : toSnake(effectiveName),
            sqlType     : 'VARCHAR(64)',
            jsonType    : 'string',
            nullable    : isOptional,
            isPrimaryKey: false,
            isForeignKey: false,
            referencesEntity: null,
            isEnum      : true,
            enumRef     : typeName,
            constraints : { enum: enumDef.values },
            documentation: _docs(el),
          });
        } else {
          const stDef = this.simpleTypes.get(typeName);
          entity.columns.push({
            name        : toCamel(effectiveName),
            columnName  : toSnake(effectiveName),
            sqlType     : stDef?.sqlType   || 'TEXT',
            jsonType    : stDef?.jsonType  || 'string',
            nullable    : isOptional,
            isPrimaryKey: false,
            isForeignKey: false,
            referencesEntity: null,
            isEnum      : false,
            enumRef     : null,
            constraints : stDef?.constraints || {},
            documentation: _docs(el),
          });
        }
        return;
      }

      if (resolved.kind === 'complex') {
        // In S3000L mode, only create a relation if the target is a real entity.
        // Otherwise treat the nested type as an opaque JSON column.
        if (this._s3000lMode && !this._s3000lSet.has(typeName)) {
          entity.columns.push({
            name        : toCamel(effectiveName),
            columnName  : toSnake(effectiveName),
            sqlType     : 'LONGTEXT',          // MariaDB: store JSON as LONGTEXT
            jsonType    : 'object',
            nullable    : isOptional,
            isPrimaryKey: false,
            isForeignKey: false,
            referencesEntity: null,
            isEnum      : false,
            enumRef     : null,
            constraints : {},
            documentation: `Inline complex type ${typeName} (not a real S3000L entity)`,
          });
          return;
        }
        // Make sure the referenced entity is built
        if (!this._visited.has(typeName)) {
          this._processComplexType(typeName, resolved.node);
        }
        this._addRelation(entity, effectiveName, typeName, isOptional, minOccurs, maxOccurs);
        return;
      }

      // kind === 'unknown' — treat as text column for now
      entity.columns.push({
        name        : toCamel(effectiveName),
        columnName  : toSnake(effectiveName),
        sqlType     : 'TEXT',
        jsonType    : 'string',
        nullable    : isOptional,
        isPrimaryKey: false,
        isForeignKey: false,
        referencesEntity: null,
        isEnum      : false,
        enumRef     : null,
        constraints : {},
        documentation: `Unresolved type: ${typeName}`,
      });
    }
  }

  // ── attribute processing ───────────────────────────────────────────────────

  _processAttribute(entity, attr) {
    const attrName  = attr['@_name'];
    const attrRef   = attr['@_ref'];
    const typeName  = attr['@_type'];
    const use       = attr['@_use'] || 'optional';
    const nullable  = use !== 'required';

    const effectiveName = attrName || attrRef;
    if (!effectiveName) return;

    const resolved = typeName ? this.resolver.resolve(typeName) : { kind: 'primitive', sqlType: 'TEXT', jsonType: 'string' };

    const colBase = {
      name        : toCamel(effectiveName),
      columnName  : toSnake(effectiveName),
      nullable,
      isPrimaryKey: false,
      isForeignKey: false,
      referencesEntity: null,
      documentation: _docs(attr),
    };

    if (resolved.kind === 'primitive') {
      entity.columns.push({
        ...colBase,
        sqlType    : resolved.sqlType,
        jsonType   : resolved.jsonType,
        isEnum     : false,
        enumRef    : null,
        constraints: {
          ...(resolved.minimum  != null ? { minimum:  resolved.minimum  } : {}),
          ...(resolved.maximum  != null ? { maximum:  resolved.maximum  } : {}),
          ...(resolved.format   != null ? { format:   resolved.format   } : {}),
          ...(resolved.isId    ? { isId:    true } : {}),
          ...(resolved.isIdRef ? { isIdRef: true } : {}),
        },
      });
    } else {
      const enumDef = this.enums.get(typeName);
      entity.columns.push({
        ...colBase,
        sqlType    : enumDef ? 'VARCHAR(64)' : 'TEXT',
        jsonType   : 'string',
        isEnum     : !!enumDef,
        enumRef    : enumDef ? typeName : null,
        constraints: enumDef ? { enum: enumDef.values } : {},
      });
    }
  }

  // ── relation helper ────────────────────────────────────────────────────────

  _addRelation(entity, fieldName, targetEntity, nullable, minOccurs, maxOccurs) {
    const isRepeating = maxOccurs === 'unbounded' || maxOccurs > 1;
    const kind        = isRepeating ? 'one-to-many' : 'one-to-one';

    entity.relations.push({
      kind,
      fieldName,
      targetEntity,
      joinTable : null,
      nullable,
      minOccurs,
      maxOccurs,
    });

    // For one-to-one, add the FK column on this side
    if (!isRepeating) {
      entity.columns.push({
        name        : toCamel(fieldName) + 'Id',
        columnName  : toSnake(fieldName) + '_id',
        sqlType     : 'BIGINT',
        jsonType    : 'integer',
        nullable,
        isPrimaryKey: false,
        isForeignKey: true,
        referencesEntity: targetEntity,
        isEnum      : false,
        enumRef     : null,
        constraints : {},
        documentation: `FK → ${targetEntity}`,
      });
    }
  }
}

// ─── private helpers ──────────────────────────────────────────────────────────

function _parseOccurs(val, defaultVal) {
  if (val === undefined || val === null) return defaultVal;
  if (val === 'unbounded') return 'unbounded';
  const n = parseInt(val, 10);
  return isNaN(n) ? defaultVal : n;
}

function _docs(node) {
  try {
    const ann  = (node.annotation  || [])[0];
    const docs = (ann?.documentation || [])[0];
    if (!docs) return null;
    if (typeof docs === 'string') return docs.trim();
    if (typeof docs === 'object') return (docs['#text'] || '').trim();
  } catch { /* ignore */ }
  return null;
}

function _dig(node, ...keys) {
  let cur = node;
  for (const k of keys) {
    if (!cur) return null;
    const val = cur[k];
    if (val === undefined || val === null) return null;
    // Accept both array form (after isArray fix) and plain object
    cur = Array.isArray(val) ? val[0] : val;
    if (!cur) return null;
  }
  return cur || null;
}

function _extractConstraints(restriction) {
  const pick = (k) => restriction[k]?.[0]?.['@_value'];
  return Object.fromEntries(
    ['minLength','maxLength','minInclusive','maxInclusive',
     'minExclusive','maxExclusive','pattern','totalDigits','fractionDigits']
      .map(k => [k, pick(k)])
      .filter(([, v]) => v !== undefined)
  );
}

function _surrogateKey() {
  return {
    name        : 'id',
    columnName  : 'id',
    sqlType     : 'BIGINT',        // MariaDB: BIGINT AUTO_INCREMENT
    jsonType    : 'integer',
    nullable    : false,
    isPrimaryKey: true,
    isForeignKey: false,
    referencesEntity: null,
    isEnum      : false,
    enumRef     : null,
    constraints : {},
    documentation: 'Surrogate primary key',
  };
}

/**
 * Technical tracking columns added to every S3000L real entity.
 * Prefixed with _ so they are never serialised into the XML dump.
 * Types use MariaDB dialect.
 */
function _s3000lTechColumns() {
  const base = {
    isPrimaryKey: false, isForeignKey: false,
    referencesEntity: null, isEnum: false, enumRef: null, constraints: {},
  };
  return [
    { ...base, name: '_createdAt',  columnName: '_created_at',  sqlType: 'DATETIME(3)', jsonType: 'string',  nullable: false, documentation: 'Technical: row insert timestamp' },
    { ...base, name: '_updatedAt',  columnName: '_updated_at',  sqlType: 'DATETIME(3)', jsonType: 'string',  nullable: false, documentation: 'Technical: row last-update timestamp' },
    { ...base, name: '_deletedAt',  columnName: '_deleted_at',  sqlType: 'DATETIME(3)', jsonType: 'string',  nullable: true,  documentation: 'Technical: soft-delete (crud=D)' },
    { ...base, name: '_msgSeq',     columnName: '_msg_seq',     sqlType: 'BIGINT',      jsonType: 'integer', nullable: false, documentation: 'Technical: last export message sequence — used for net-change delta' },
  ];
}

module.exports = { IRBuilder };