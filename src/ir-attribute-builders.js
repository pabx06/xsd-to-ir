function attributeColumn({
  fieldName,
  typeName,
  resolved,
  enumDef,
  nullable,
  defaultValue,
  documentation,
  isS3000LUid,
  helpers,
}) {
  const base = {
    name: helpers.toCamel(fieldName),
    columnName: helpers.toDbName(fieldName),
    ...helpers.attributeColumnMeta(fieldName),
    nullable,
    defaultValue,
    isPrimaryKey: false,
    isForeignKey: false,
    referencesEntity: null,
    documentation,
    xsdType: typeName || null,
  };

  if (resolved.kind === 'primitive') {
    return {
      ...base,
      sqlType: isS3000LUid ? 'VARCHAR(255)' : resolved.sqlType,
      jsonType: resolved.jsonType,
      isEnum: false,
      enumRef: null,
      constraints: primitiveAttributeConstraints(resolved),
    };
  }

  return {
    ...base,
    sqlType: enumDef ? 'VARCHAR(64)' : 'TEXT',
    jsonType: 'string',
    isEnum: !!enumDef,
    enumRef: enumDef ? typeName : null,
    constraints: enumDef ? { enum: enumDef.values } : {},
  };
}

function primitiveAttributeConstraints(resolved) {
  return {
    ...(resolved.minimum != null ? { minimum: resolved.minimum } : {}),
    ...(resolved.maximum != null ? { maximum: resolved.maximum } : {}),
    ...(resolved.format != null ? { format: resolved.format } : {}),
    ...(resolved.isId ? { isId: true } : {}),
    ...(resolved.isIdRef ? { isIdRef: true } : {}),
  };
}

module.exports = {
  attributeColumn,
};
