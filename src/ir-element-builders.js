function primitiveElementColumn({
  fieldName,
  typeName,
  resolved,
  nullable,
  minOccurs,
  maxOccurs,
  documentation,
  helpers,
}) {
  return {
    name: helpers.toCamel(fieldName),
    columnName: helpers.toDbName(fieldName),
    ...helpers.elementColumnMeta(fieldName, minOccurs, maxOccurs),
    sqlType: resolved.sqlType,
    jsonType: resolved.jsonType,
    nullable,
    defaultValue: null,
    isPrimaryKey: false,
    isForeignKey: resolved.isIdRef || false,
    referencesEntity: null,
    isEnum: false,
    enumRef: null,
    constraints: primitiveConstraints(resolved),
    documentation,
    xsdType: typeName,
  };
}

function primitiveConstraints(resolved) {
  return {
    ...(resolved.minimum != null ? { minimum: resolved.minimum } : {}),
    ...(resolved.maximum != null ? { maximum: resolved.maximum } : {}),
    ...(resolved.format != null ? { format: resolved.format } : {}),
    ...(resolved.isId ? { isId: true } : {}),
    ...(resolved.isIdRef ? { isIdRef: true } : {}),
    ...(resolved.isIdRefs ? { isIdRefs: true } : {}),
  };
}

function idRefsJoinTable({ entity, fieldName, helpers }) {
  const joinName = helpers.shortenIdentifier(`${entity.tableName}__${helpers.toSnake(fieldName)}`);
  return {
    name: joinName,
    tableName: joinName,
    leftEntity: entity.name,
    leftColumn: helpers.shortenIdentifier(`${helpers.toSnake(entity.name)}_id`),
    rightEntity: helpers.toPascal(fieldName),
    rightColumn: helpers.shortenIdentifier(`${helpers.toSnake(fieldName)}_id`),
    documentation: `Join table for IDREFS ${entity.name}.${fieldName}`,
  };
}

function ensureRepeatedPrimitiveEntity({
  entities,
  parentEntity,
  fieldName,
  typeName,
  resolved,
  minOccurs,
  maxOccurs,
  helpers,
}) {
  const childName = helpers.toPascal(`${parentEntity.name}_${helpers.toPascal(fieldName)}`);
  if (entities.has(childName)) return childName;

  entities.set(childName, {
    name: childName,
    tableName: helpers.toDbName(childName),
    columns: [
      helpers.surrogateKey(),
      {
        name: `${helpers.toCamel(parentEntity.name)}Id`,
        columnName: helpers.shortenIdentifier(`${helpers.toSnake(parentEntity.name)}_id`),
        ...helpers.internalColumnMeta(),
        sqlType: 'BIGINT',
        jsonType: 'integer',
        nullable: false,
        defaultValue: null,
        isPrimaryKey: false,
        isForeignKey: true,
        referencesEntity: parentEntity.name,
        isEnum: false,
        enumRef: null,
        constraints: {},
        documentation: `FK back to ${parentEntity.name}`,
        xsdType: parentEntity.name,
      },
      {
        name: 'value',
        columnName: 'value',
        ...helpers.elementColumnMeta(fieldName, minOccurs, maxOccurs),
        sqlType: resolved.sqlType,
        jsonType: resolved.jsonType,
        nullable: false,
        defaultValue: null,
        isPrimaryKey: false,
        isForeignKey: false,
        referencesEntity: null,
        isEnum: false,
        enumRef: null,
        constraints: {},
        documentation: null,
        xsdType: typeName,
      },
    ],
    relations: [],
    abstract: false,
    parentType: null,
    documentation: `Repeated ${typeName} values for ${parentEntity.name}.${fieldName}`,
  });

  return childName;
}

function repeatedPrimitiveRelation({
  parentEntity,
  fieldName,
  childName,
  nullable,
  minOccurs,
  maxOccurs,
  helpers,
}) {
  return {
    kind: 'one-to-many',
    fieldName,
    targetEntity: childName,
    joinTable: null,
    parentColumn: helpers.shortenIdentifier(`${helpers.toSnake(parentEntity.name)}_id`),
    nullable,
    minOccurs,
    maxOccurs,
  };
}

function simpleElementColumn({
  fieldName,
  typeName,
  simpleType,
  enumDef,
  nullable,
  minOccurs,
  maxOccurs,
  documentation,
  helpers,
}) {
  return {
    name: helpers.toCamel(fieldName),
    columnName: helpers.toDbName(fieldName),
    ...helpers.elementColumnMeta(fieldName, minOccurs, maxOccurs),
    sqlType: enumDef ? 'VARCHAR(64)' : simpleType?.sqlType || 'TEXT',
    jsonType: enumDef ? 'string' : simpleType?.jsonType || 'string',
    nullable,
    defaultValue: null,
    isPrimaryKey: false,
    isForeignKey: false,
    referencesEntity: null,
    isEnum: !!enumDef,
    enumRef: enumDef ? typeName : null,
    constraints: enumDef ? { enum: enumDef.values } : simpleType?.constraints || {},
    documentation,
    xsdType: typeName,
  };
}

function inlineComplexElementColumn({
  fieldName,
  typeName,
  nullable,
  minOccurs,
  maxOccurs,
  helpers,
}) {
  return {
    name: helpers.toCamel(fieldName),
    columnName: helpers.toDbName(fieldName),
    ...helpers.elementColumnMeta(fieldName, minOccurs, maxOccurs),
    sqlType: 'LONGTEXT',
    jsonType: 'object',
    nullable,
    defaultValue: null,
    isPrimaryKey: false,
    isForeignKey: false,
    referencesEntity: null,
    isEnum: false,
    enumRef: null,
    constraints: {},
    documentation: `Inline complex type ${typeName} (not a real S3000L entity)`,
    xsdType: typeName,
  };
}

function unknownElementColumn({
  fieldName,
  typeName,
  nullable,
  minOccurs,
  maxOccurs,
  helpers,
}) {
  return {
    name: helpers.toCamel(fieldName),
    columnName: helpers.toDbName(fieldName),
    ...helpers.elementColumnMeta(fieldName, minOccurs, maxOccurs),
    sqlType: 'TEXT',
    jsonType: 'string',
    nullable,
    defaultValue: null,
    isPrimaryKey: false,
    isForeignKey: false,
    referencesEntity: null,
    isEnum: false,
    enumRef: null,
    constraints: {},
    documentation: `Unresolved type: ${typeName}`,
    xsdType: typeName,
  };
}

module.exports = {
  ensureRepeatedPrimitiveEntity,
  idRefsJoinTable,
  inlineComplexElementColumn,
  primitiveElementColumn,
  repeatedPrimitiveRelation,
  simpleElementColumn,
  unknownElementColumn,
};
