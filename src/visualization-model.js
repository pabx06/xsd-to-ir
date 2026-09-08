/**
 * Convert the Map-heavy IR into a browser-safe model for the visualizer.
 *
 * The visualizer deliberately consumes a separate model instead of reaching
 * into the IR shape. This keeps the UI stable as the parser and generators
 * evolve, and makes the model useful to other read-only tooling.
 */

function entries(value) {
  if (value instanceof Map) return [...value.entries()];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value);
}

function clone(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function isRecordEntity(entity) {
  const columns = entity.columns || [];
  return columns.some((column) => column.name === 'uid')
    && columns.some((column) => column.name === 'crud');
}

function isSyntheticEntity(entity) {
  const documentation = String(entity.documentation || '').toLowerCase();
  return !isRecordEntity(entity)
    && (documentation.includes('synthetic') || documentation.includes('repeated'));
}

function relationId(source, relation, index) {
  return [source, relation.fieldName, relation.targetEntity || 'unresolved', index].join('::');
}

function buildIslands(entities, edges) {
  const entityNames = new Set(entities.map((entity) => entity.name));
  const neighbors = new Map(entities.map((entity) => [entity.name, new Set()]));
  edges.forEach((edge) => {
    if (!entityNames.has(edge.source) || !entityNames.has(edge.target)) return;
    neighbors.get(edge.source).add(edge.target);
    neighbors.get(edge.target).add(edge.source);
  });

  const visited = new Set();
  const components = [];
  [...entityNames].sort().forEach((name) => {
    if (visited.has(name)) return;
    const component = [];
    const queue = [name];
    visited.add(name);
    while (queue.length) {
      const current = queue.shift();
      component.push(current);
      [...neighbors.get(current)].sort().forEach((neighbor) => {
        if (visited.has(neighbor)) return;
        visited.add(neighbor);
        queue.push(neighbor);
      });
    }
    components.push(component.sort());
  });

  components.sort((left, right) => left[0].localeCompare(right[0]));
  const entityToIsland = new Map();
  const islands = components.map((entityNamesInIsland, index) => {
    const id = `island-${String(index + 1).padStart(3, '0')}`;
    const members = new Set(entityNamesInIsland);
    entityNamesInIsland.forEach((name) => entityToIsland.set(name, id));
    const islandEntities = entities.filter((entity) => members.has(entity.name));
    const islandEdges = edges.filter((edge) => members.has(edge.source) && members.has(edge.target));
    const recordEntities = islandEntities.filter((entity) => entity.recordEntity).map((entity) => entity.name);
    const syntheticEntities = islandEntities.filter((entity) => entity.synthetic).map((entity) => entity.name);
    const sections = [...new Set(islandEntities.map((entity) => entity.collection?.section || 'unmapped'))].sort();
    return {
      id,
      index: index + 1,
      entityNames: entityNamesInIsland,
      recordEntities,
      syntheticEntities,
      entityCount: entityNamesInIsland.length,
      relationCount: islandEdges.length,
      recordEntityCount: recordEntities.length,
      syntheticEntityCount: syntheticEntities.length,
      crudUiCount: recordEntities.length,
      sections,
    };
  });

  return { entityToIsland, islands };
}

function buildVisualizationModel(ir, options = {}) {
  if (!ir || typeof ir !== 'object') {
    throw new TypeError('An IR object is required to build a visualization model');
  }

  const entityEntries = entries(ir.entities);
  const entityNames = new Set(entityEntries.map(([name]) => name));
  const collectionEntries = entries(ir.s3000lCollections);
  const collections = Object.fromEntries(collectionEntries.map(([name, mapping]) => [name, clone(mapping)]));
  const collectionByEntity = new Map(collectionEntries);
  const edges = [];
  const outgoingByEntity = new Map();
  const incomingByEntity = new Map();

  const entities = entityEntries.map(([mapName, rawEntity]) => {
    const entity = rawEntity || {};
    const name = entity.name || mapName;
    const relations = (entity.relations || []).map((relation, index) => {
      const targetExists = entityNames.has(relation.targetEntity);
      const edge = {
        id: relationId(name, relation, index),
        source: name,
        target: relation.targetEntity || null,
        fieldName: relation.fieldName,
        kind: relation.kind,
        joinTable: relation.joinTable || null,
        parentColumn: relation.parentColumn || null,
        flattened: !!relation.flattened,
        nullable: relation.nullable !== false,
        minOccurs: relation.minOccurs ?? 0,
        maxOccurs: relation.maxOccurs ?? 1,
        unresolved: !targetExists,
      };
      edges.push(edge);
      if (!outgoingByEntity.has(name)) outgoingByEntity.set(name, []);
      outgoingByEntity.get(name).push(edge.id);
      if (targetExists) {
        if (!incomingByEntity.has(relation.targetEntity)) incomingByEntity.set(relation.targetEntity, []);
        incomingByEntity.get(relation.targetEntity).push(edge.id);
      }
      return clone(relation);
    });

    return {
      ...clone(entity),
      name,
      tableName: entity.tableName || null,
      columns: clone(entity.columns || []),
      relations,
      collection: collectionByEntity.has(name) ? clone(collectionByEntity.get(name)) : null,
      recordEntity: isRecordEntity(entity),
      synthetic: isSyntheticEntity(entity),
    };
  });

  const assertions = Object.fromEntries(entries(ir.assertions).map(([name, assertion]) => [name, clone(assertion)]));
  const assertionPaths = Object.fromEntries(
    entries(ir.assertionPaths).map(([name, assertionPath]) => [name, clone(assertionPath)]),
  );

  const relationCount = edges.length;
  const columnCount = entities.reduce((total, entity) => total + entity.columns.length, 0);
  const recordEntityCount = entities.filter((entity) => entity.recordEntity).length;
  const syntheticEntityCount = entities.filter((entity) => entity.synthetic).length;
  const islandData = buildIslands(entities, edges);
  entities.forEach((entity) => {
    entity.islandId = islandData.entityToIsland.get(entity.name);
  });

  return {
    version: 1,
    source: options.source || null,
    dialect: ir.s3000lDialect ?? null,
    s3000lMode: !!ir.s3000lMode,
    stats: {
      entities: entities.length,
      recordEntities: recordEntityCount,
      syntheticEntities: syntheticEntityCount,
      columns: columnCount,
      relations: relationCount,
      islands: islandData.islands.length,
      crudUis: recordEntityCount,
      joinTables: entries(ir.joinTables).length,
      enums: entries(ir.enums).length,
      simpleTypes: entries(ir.simpleTypes).length,
      assertions: Object.keys(assertions).length,
      assertionPaths: Object.keys(assertionPaths).length,
    },
    entities,
    edges,
    islands: islandData.islands,
    collections,
    enums: Object.fromEntries(entries(ir.enums).map(([name, value]) => [name, clone(value)])),
    simpleTypes: Object.fromEntries(entries(ir.simpleTypes).map(([name, value]) => [name, clone(value)])),
    assertions,
    assertionPaths,
    outgoingByEntity: Object.fromEntries(outgoingByEntity),
    incomingByEntity: Object.fromEntries(incomingByEntity),
  };
}

function buildNeighborhood(model, entityName, depth = 1, maxNodes = 42) {
  const entityNames = new Set((model.entities || []).map((entity) => entity.name));
  if (!entityNames.has(entityName)) return { entityNames: [], edges: [], omitted: 0 };

  const distances = new Map([[entityName, 0]]);
  const queue = [entityName];
  while (queue.length) {
    const current = queue.shift();
    if (distances.get(current) >= depth) continue;
    (model.edges || []).forEach((edge) => {
      if (edge.source !== current && edge.target !== current) return;
      const neighbor = edge.source === current ? edge.target : edge.source;
      if (!neighbor || !entityNames.has(neighbor) || distances.has(neighbor)) return;
      distances.set(neighbor, distances.get(current) + 1);
      queue.push(neighbor);
    });
  }

  const ordered = [...distances.entries()]
    .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]));
  const selected = new Set(ordered.slice(0, maxNodes).map(([name]) => name));
  return {
    entityNames: [...selected],
    edges: (model.edges || []).filter((edge) => selected.has(edge.source) && selected.has(edge.target)),
    omitted: Math.max(0, ordered.length - maxNodes),
  };
}

module.exports = { buildIslands, buildNeighborhood, buildVisualizationModel };
