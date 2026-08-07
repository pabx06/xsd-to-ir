function isRepeating(maxOccurs) {
  return maxOccurs === 'unbounded' || maxOccurs > 1;
}

function choiceBranchNames(choice) {
  return [
    ...(choice.element || []).map((branch) => branch['@_name']).filter(Boolean),
    ...(choice.group || []).map((branch) => branch['@_ref']).filter(Boolean),
  ];
}

function uniqueColumnName(entity, preferredName, suffix, helpers) {
  const usedNames = new Set(
    entity.columns.map((column) => column.columnName.toLowerCase()),
  );
  if (!usedNames.has(preferredName.toLowerCase())) {
    return preferredName;
  }
  const baseName = preferredName.endsWith('_id')
    ? preferredName.slice(0, -3)
    : preferredName;

  let candidate = helpers.shortenIdentifier(`${baseName}_${suffix}_id`);
  let index = 2;

  while (usedNames.has(candidate.toLowerCase())) {
    candidate = helpers.shortenIdentifier(
      `${baseName}_${suffix}_${index}_id`,
    );
    index += 1;
  }

  return candidate;
}

function addChoiceDiscriminator(entity, branchNames, helpers) {
  const alreadyHasDiscriminator = entity.columns.some((c) => c.columnName === 'choice_type');
  if (branchNames.length <= 1 || alreadyHasDiscriminator) return;

  entity.columns.push({
    name: 'choiceType',
    columnName: 'choice_type',
    ...helpers.internalColumnMeta(),
    sqlType: 'VARCHAR(64)',
    jsonType: 'string',
    nullable: true,
    defaultValue: null,
    isPrimaryKey: false,
    isForeignKey: false,
    referencesEntity: null,
    isEnum: false,
    enumRef: null,
    constraints: { enum: branchNames },
    documentation: 'Discriminator for xs:choice',
  });
}

function addRelationToEntity({
  entity,
  entities,
  fieldName,
  targetEntity,
  nullable,
  minOccurs,
  maxOccurs,
  helpers,
}) {
  const repeating = isRepeating(maxOccurs);
  const kind = repeating ? 'one-to-many' : 'one-to-one';
  const parentColumn = repeating
    ? ensureRelationParentColumn({
      entities,
      parentEntity: entity.name,
      fieldName,
      targetEntity,
      helpers,
    })
    : null;

  entity.relations.push({
    kind,
    fieldName,
    targetEntity,
    joinTable: null,
    parentColumn,
    nullable,
    minOccurs,
    maxOccurs,
  });

  if (!repeating) {
    entity.columns.push(oneToOneRelationColumn({
      entity,
      fieldName,
      targetEntity,
      nullable,
      minOccurs,
      maxOccurs,
      helpers,
    }));
  }
}

function ensureRelationParentColumn({
  entities,
  parentEntity,
  fieldName,
  targetEntity,
  helpers,
}) {
  const child = entities.get(targetEntity);
  if (!child) return null;

  const columnName = helpers.shortenIdentifier(
    `${helpers.toSnake(parentEntity)}_${helpers.toSnake(fieldName)}_parent_id`,
  );
  if (child.columns.some((c) => c.columnName === columnName)) return columnName;

  child.columns.push({
    name: `${helpers.toCamel(parentEntity)}${helpers.toPascal(fieldName)}ParentId`,
    columnName,
    ...helpers.internalColumnMeta(),
    sqlType: 'BIGINT',
    jsonType: 'integer',
    nullable: true,
    defaultValue: null,
    isPrimaryKey: false,
    isForeignKey: true,
    referencesEntity: parentEntity,
    isEnum: false,
    enumRef: null,
    constraints: {},
    documentation: `FK back to parent ${parentEntity}.${fieldName}`,
    xsdType: parentEntity,
  });

  return columnName;
}

function oneToOneRelationColumn({
  entity,
  fieldName,
  targetEntity,
  nullable,
  minOccurs,
  maxOccurs,
  helpers,
}) {
  const preferredColumnName = helpers.shortenIdentifier(`${helpers.toSnake(fieldName)}_id`);
  const columnName = uniqueColumnName(entity, preferredColumnName, 'relation', helpers);
  const hasCollision = columnName !== preferredColumnName;
  return {
    name: hasCollision ? `${helpers.toCamel(fieldName)}RelationId` : `${helpers.toCamel(fieldName)}Id`,
    columnName,
    ...helpers.relationColumnMeta(fieldName, minOccurs, maxOccurs),
    sqlType: 'BIGINT',
    jsonType: 'integer',
    nullable,
    defaultValue: null,
    isPrimaryKey: false,
    isForeignKey: true,
    referencesEntity: targetEntity,
    isEnum: false,
    enumRef: null,
    constraints: {},
    documentation: `FK -> ${targetEntity}`,
    xsdType: targetEntity,
  };
}

function ensureSyntheticGroupEntity({
  entities,
  parentEntity,
  groupName,
  helpers,
}) {
  const childName = helpers.toPascal(`${parentEntity.name}_${helpers.toPascal(groupName)}`);
  if (entities.has(childName)) {
    return { childName, createdEntity: null };
  }

  const createdEntity = {
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
        documentation: `FK back to ${parentEntity.name} (from group ${groupName})`,
        xsdType: parentEntity.name,
      },
    ],
    relations: [],
    abstract: false,
    parentType: null,
    documentation: `Synthetic entity for repeated xs:group "${groupName}" in ${parentEntity.name}`,
  };

  entities.set(childName, createdEntity);
  return { childName, createdEntity };
}

function flattenedGroupRelation({
  parentEntity,
  groupName,
  childName,
  minOccurs,
  maxOccurs,
  helpers,
}) {
  return {
    kind: 'one-to-many',
    fieldName: groupName,
    targetEntity: childName,
    joinTable: null,
    parentColumn: helpers.shortenIdentifier(`${helpers.toSnake(parentEntity.name)}_id`),
    flattened: true,
    nullable: minOccurs === 0,
    minOccurs,
    maxOccurs,
  };
}

module.exports = {
  addChoiceDiscriminator,
  addRelationToEntity,
  choiceBranchNames,
  ensureSyntheticGroupEntity,
  flattenedGroupRelation,
  isRepeating,
  oneToOneRelationColumn,
};
