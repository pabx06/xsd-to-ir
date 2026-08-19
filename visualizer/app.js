/* eslint-env browser */

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_GRAPH_NODES = 42;
const state = {
  model: null,
  entities: new Map(),
  selected: null,
  search: '',
  showSynthetic: false,
  section: '',
  depth: 1,
  zoom: 1,
  panX: 0,
  panY: 0,
};

const elements = {};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function entityCollection(entity) {
  return entity.collection || null;
}

function entitySection(entity) {
  return entityCollection(entity)?.section || 'unmapped';
}

function entityMatches(entity) {
  if (!state.showSynthetic && entity.synthetic) return false;
  if (state.section && entitySection(entity) !== state.section) return false;
  if (!state.search) return true;

  const fields = [entity.name, entity.tableName, entity.documentation, entityCollection(entity)?.collectionName];
  for (const column of entity.columns || []) {
    fields.push(column.name, column.columnName, column.xmlName, column.xsdType, column.enumRef);
  }
  return fields.filter(Boolean).some((field) => String(field).toLowerCase().includes(state.search));
}

function setHash() {
  const params = new URLSearchParams();
  if (state.selected) params.set('entity', state.selected);
  if (state.section) params.set('section', state.section);
  if (state.search) params.set('q', state.search);
  if (state.showSynthetic) params.set('synthetic', '1');
  if (state.depth !== 1) params.set('depth', String(state.depth));
  window.history.replaceState(null, '', params.toString() ? `#${params}` : window.location.pathname);
}

function readHash() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  state.selected = params.get('entity');
  state.section = params.get('section') || '';
  state.search = (params.get('q') || '').toLowerCase();
  state.showSynthetic = params.get('synthetic') === '1';
  state.depth = params.get('depth') === '2' ? 2 : 1;
}

function formatOccurrence(column) {
  const min = column.minOccurs ?? 0;
  const max = column.maxOccurs ?? 1;
  return `${min}..${max}`;
}

function formatConstraints(column) {
  const constraints = column.constraints || {};
  const parts = [];
  if (constraints.enum) parts.push(`enum: ${constraints.enum.join(', ')}`);
  if (constraints.minimum != null) parts.push(`min: ${constraints.minimum}`);
  if (constraints.maximum != null) parts.push(`max: ${constraints.maximum}`);
  if (constraints.minLength != null) parts.push(`minLength: ${constraints.minLength}`);
  if (constraints.maxLength != null) parts.push(`maxLength: ${constraints.maxLength}`);
  if (constraints.pattern) parts.push(`pattern: ${constraints.pattern}`);
  return parts.join(' · ') || '—';
}

function relationText(relation) {
  const target = relation.target || relation.targetEntity || 'unresolved';
  const maximum = relation.maxOccurs === 'unbounded' ? 'many' : relation.maxOccurs;
  return `${relation.kind || 'relation'} · ${relation.minOccurs ?? 0}..${maximum} · ${target}`;
}

function createElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
}

function renderNavigator() {
  const groups = new Map();
  const visible = state.model.entities.filter(entityMatches).sort((left, right) => left.name.localeCompare(right.name));
  visible.forEach((entity) => {
    const section = entitySection(entity);
    const collection = entityCollection(entity)?.collectionName || 'Other entities';
    if (!groups.has(section)) groups.set(section, new Map());
    if (!groups.get(section).has(collection)) groups.get(section).set(collection, []);
    groups.get(section).get(collection).push(entity);
  });

  const sectionLabels = {
    lsaPrimaryData: 'Primary data',
    lsaSupportingData: 'Supporting data',
    unmapped: 'Unmapped and helper entities',
  };
  const html = [];
  [...groups.keys()].sort().forEach((section) => {
    html.push(`<section class="tree-section"><div class="tree-title">${escapeHtml(sectionLabels[section] || section)}</div>`);
    [...groups.get(section).keys()].sort().forEach((collection) => {
      html.push(`<details class="tree-collection" open><summary>${escapeHtml(collection)}</summary>`);
      groups.get(section).get(collection).forEach((entity) => {
        const selected = entity.name === state.selected ? ' selected' : '';
        const synthetic = entity.synthetic ? ' synthetic' : '';
        html.push(`<button class="entity-link${selected}${synthetic}" data-entity="${escapeHtml(entity.name)}" type="button">`);
        html.push(`<span>${escapeHtml(entity.name)}</span><small>${entity.columns.length}f</small></button>`);
      });
      html.push('</details>');
    });
    html.push('</section>');
  });

  elements.navigator.innerHTML = html.join('') || '<div class="empty-state">No entities match the current filters.</div>';
  elements.entityCount.textContent = `${visible.length}/${state.model.stats.entities}`;
}

function getRelations(entityName) {
  return state.model.edges.filter((edge) => edge.source === entityName || edge.target === entityName);
}

function assertionMatches(entity) {
  const types = new Set([entity.name, ...(entity.columns || []).map((column) => column.xsdType).filter(Boolean)]);
  const matches = [];
  Object.values(state.model.assertions).forEach((assertion) => {
    if (types.has(assertion.typeName)) matches.push({ kind: 'assertion', value: assertion });
  });
  Object.values(state.model.assertionPaths).forEach((assertionPath) => {
    if (types.has(assertionPath.typeName)) matches.push({ kind: 'path', value: assertionPath });
  });
  return matches;
}

function renderDetails() {
  const entity = state.entities.get(state.selected);
  if (!entity) {
    elements.details.innerHTML = '<div class="empty-state">Choose an entity from the navigator or graph.</div>';
    return;
  }

  const collection = entityCollection(entity);
  const tags = [
    entity.recordEntity ? 'S3000L record' : 'IR entity',
    entity.synthetic ? 'synthetic helper' : null,
    collection?.section || null,
  ].filter(Boolean);
  const relationRows = getRelations(entity.name).map((relation) => {
    const other = relation.source === entity.name ? relation.target : relation.source;
    const direction = relation.source === entity.name ? 'outgoing' : 'incoming';
    const targetButton = state.entities.has(other)
      ? `<button type="button" data-entity="${escapeHtml(other)}">${escapeHtml(other)}</button>`
      : escapeHtml(other || 'unresolved');
    return `<div class="relation-item"><strong>${escapeHtml(relation.fieldName)}</strong> → ${targetButton}<br><small>${escapeHtml(direction)} · ${escapeHtml(relationText(relation))}${relation.flattened ? ' · flattened' : ''}</small></div>`;
  });
  const columns = (entity.columns || []).map((column) => {
    const reference = column.referencesEntity ? ` → ${column.referencesEntity}` : '';
    return `<tr><td>${escapeHtml(column.name)}<div class="field-meta">${escapeHtml(column.xmlName || column.xmlKind || '')}</div></td><td>${escapeHtml(column.sqlType || '—')} / ${escapeHtml(column.jsonType || '—')}<div class="field-meta">${escapeHtml(column.xsdType || '')}</div></td><td>${escapeHtml(formatOccurrence(column))}<div class="field-meta">${column.nullable ? 'nullable' : 'required'}${escapeHtml(reference)}</div></td><td>${escapeHtml(formatConstraints(column))}</td></tr>`;
  }).join('');
  const assertionRows = assertionMatches(entity).map((match) => {
    const count = (match.value.rules || match.value.paths || []).length;
    return `<div class="relation-item"><strong>${escapeHtml(match.value.typeName)}</strong><br><small>${escapeHtml(match.kind)} · ${count} rule${count === 1 ? '' : 's'}</small></div>`;
  }).join('');

  elements.details.innerHTML = [
    '<section class="detail-section">',
    `<div class="detail-title"><h3>${escapeHtml(entity.name)}</h3><span class="tag">${escapeHtml(entity.tableName || 'no table')}</span></div>`,
    `<div class="detail-subtitle">${escapeHtml(entity.documentation || 'No documentation available.')}</div>`,
    `<div class="tag-list">${tags.map((tag) => `<span class="tag${tag === 'synthetic helper' ? ' synthetic' : ''}">${escapeHtml(tag)}</span>`).join('')}</div>`,
    '<dl class="kv">',
    `<dt>XML collection</dt><dd>${escapeHtml(collection?.collectionName || '—')}</dd>`,
    `<dt>XML record</dt><dd>${escapeHtml(collection?.recordName || '—')}</dd>`,
    `<dt>Fields</dt><dd>${entity.columns.length}</dd>`,
    `<dt>Relations</dt><dd>${getRelations(entity.name).length}</dd>`,
    '</dl></section>',
    '<section class="detail-section"><h3>Fields</h3>',
    '<table class="field-table"><thead><tr><th>Name / XML</th><th>Types</th><th>Occurrence</th><th>Constraints</th></tr></thead>',
    `<tbody>${columns || '<tr><td colspan="4">No fields</td></tr>'}</tbody></table></section>`,
    '<section class="detail-section"><h3>Relations</h3>',
    `<div class="relation-list">${relationRows.join('') || '<div class="muted">No relationships.</div>'}</div></section>`,
    assertionRows ? `<section class="detail-section"><h3>Assertions</h3><div class="relation-list">${assertionRows}</div></section>` : '',
  ].join('');
}

function neighborhood(entityName) {
  const depth = new Map([[entityName, 0]]);
  const queue = [entityName];
  while (queue.length) {
    const current = queue.shift();
    if (depth.get(current) >= state.depth) continue;
    getRelations(current).forEach((edge) => {
      const other = edge.source === current ? edge.target : edge.source;
      if (!other || !state.entities.has(other) || depth.has(other)) return;
      depth.set(other, depth.get(current) + 1);
      queue.push(other);
    });
  }
  const ordered = [...depth.entries()].sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]));
  return {
    depths: new Map(ordered.slice(0, MAX_GRAPH_NODES)),
    omitted: Math.max(0, ordered.length - MAX_GRAPH_NODES),
  };
}

function graphPositions(depths, width, height) {
  const positions = new Map();
  const center = { x: width / 2, y: height / 2 };
  positions.set(state.selected, center);
  [1, 2].forEach((level) => {
    const names = [...depths.entries()].filter(([, depth]) => depth === level).map(([name]) => name);
    const radius = Math.min(width, height) * (level === 1 ? 0.29 : 0.43);
    names.forEach((name, index) => {
      const angle = (-Math.PI / 2) + ((Math.PI * 2 * index) / Math.max(names.length, 1));
      positions.set(name, { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
    });
  });
  return positions;
}

function nodeBoundaryPoint(from, to) {
  const halfWidth = 92;
  const halfHeight = 26;
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  const scale = 1 / Math.max(Math.abs(deltaX) / halfWidth, Math.abs(deltaY) / halfHeight);
  return {
    x: from.x + deltaX * scale,
    y: from.y + deltaY * scale,
  };
}

function drawGraph() {
  elements.graph.innerHTML = '';
  const entity = state.entities.get(state.selected);
  if (!entity) {
    elements.graph.innerHTML = '<div class="empty-state">Select an entity to draw its relationship neighborhood.</div>';
    elements.graphSubtitle.textContent = 'Select an entity to inspect its relationships.';
    return;
  }

  const width = Math.max(elements.graph.clientWidth, 560);
  const height = Math.max(elements.graph.clientHeight, 420);
  const selectedNeighborhood = neighborhood(entity.name);
  const positions = graphPositions(selectedNeighborhood.depths, width, height);
  const visibleNames = new Set(selectedNeighborhood.depths.keys());
  const visibleEdges = state.model.edges.filter(
    (edge) => visibleNames.has(edge.source) && visibleNames.has(edge.target),
  );
  const svg = createElement('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img' });
  const defs = createElement('defs');
  ['one-to-one', 'one-to-many', 'flattened'].forEach((kind) => {
    const marker = createElement('marker', {
      id: `arrow-${kind}`, markerWidth: 12, markerHeight: 12, refX: 10, refY: 6,
      markerUnits: 'userSpaceOnUse', orient: 'auto',
    });
    let fill = '#f6c66d';
    if (kind === 'one-to-one') fill = '#63b3ed';
    if (kind === 'one-to-many') fill = '#75d8b1';
    marker.appendChild(createElement('path', { d: 'M0,0 L12,6 L0,12 z', fill }));
    defs.appendChild(marker);
  });
  svg.appendChild(defs);
  const world = createElement('g', { class: 'world' });
  const edgeLayer = createElement('g');
  const nodeLayer = createElement('g');

  visibleEdges.forEach((edge) => {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) return;
    const start = nodeBoundaryPoint(source, target);
    const end = nodeBoundaryPoint(target, source);
    const kindClass = edge.flattened ? 'flattened' : edge.kind;
    const line = createElement('line', {
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      class: `edge ${kindClass}`,
      'marker-end': `url(#arrow-${kindClass})`,
    });
    edgeLayer.appendChild(line);
    const label = createElement('text', {
      x: (source.x + target.x) / 2,
      y: (source.y + target.y) / 2 - 4,
      class: 'edge-label',
      'text-anchor': 'middle',
    });
    label.textContent = `${edge.fieldName} · ${edge.maxOccurs === 'unbounded' ? 'many' : edge.maxOccurs}`;
    edgeLayer.appendChild(label);
  });

  visibleNames.forEach((name) => {
    const current = state.entities.get(name);
    const position = positions.get(name);
    if (!current || !position) return;
    const group = createElement('g', {
      class: `node ${current.synthetic ? 'synthetic' : 'direct'}${name === state.selected ? ' selected' : ''}`,
      transform: `translate(${position.x - 92},${position.y - 26})`,
      tabindex: 0,
    });
    group.appendChild(createElement('rect', { width: 184, height: 52, rx: 7 }));
    const title = createElement('text', { x: 10, y: 21 });
    title.textContent = current.name.length > 26 ? `${current.name.slice(0, 25)}…` : current.name;
    group.appendChild(title);
    const kind = createElement('text', { x: 10, y: 38, class: 'node-kind' });
    kind.textContent = current.synthetic ? 'synthetic helper' : `${current.columns.length} fields · ${current.tableName}`;
    group.appendChild(kind);
    group.addEventListener('click', () => selectEntity(name));
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') selectEntity(name);
    });
    nodeLayer.appendChild(group);
  });
  world.appendChild(edgeLayer);
  world.appendChild(nodeLayer);
  svg.appendChild(world);
  elements.graph.appendChild(svg);
  state.panX = 0;
  state.panY = 0;
  applyGraphTransform(world);
  enableGraphPan(svg, world);
  elements.graphSubtitle.textContent = `${entity.name}: ${visibleNames.size} entities, ${visibleEdges.length} relations${selectedNeighborhood.omitted ? `, ${selectedNeighborhood.omitted} omitted` : ''}`;
}

function applyGraphTransform(world) {
  world.setAttribute('transform', `translate(${state.panX} ${state.panY}) scale(${state.zoom})`);
}

function enableGraphPan(svg, world) {
  let drag = null;
  svg.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.node')) return;
    drag = {
      x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY,
    };
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener('pointermove', (event) => {
    if (!drag) return;
    state.panX = drag.panX + event.clientX - drag.x;
    state.panY = drag.panY + event.clientY - drag.y;
    applyGraphTransform(world);
  });
  svg.addEventListener('pointerup', () => { drag = null; });
  svg.addEventListener('pointercancel', () => { drag = null; });
}

function selectEntity(name) {
  if (!state.entities.has(name)) return;
  state.selected = name;
  setHash();
  renderNavigator();
  renderDetails();
  drawGraph();
}

function bindEvents() {
  elements.navigator.addEventListener('click', (event) => {
    const button = event.target.closest('[data-entity]');
    if (button) selectEntity(button.dataset.entity);
  });
  elements.details.addEventListener('click', (event) => {
    const button = event.target.closest('[data-entity]');
    if (button) selectEntity(button.dataset.entity);
  });
  elements.search.addEventListener('input', () => {
    state.search = elements.search.value.trim().toLowerCase();
    renderNavigator();
    setHash();
  });
  elements.synthetic.addEventListener('change', () => {
    state.showSynthetic = elements.synthetic.checked;
    renderNavigator();
    setHash();
  });
  elements.section.addEventListener('change', () => {
    state.section = elements.section.value;
    renderNavigator();
    setHash();
  });
  elements.depth.addEventListener('change', () => {
    state.depth = Number(elements.depth.value);
    setHash();
    drawGraph();
  });
  elements.zoomIn.addEventListener('click', () => { state.zoom = Math.min(2.5, state.zoom + 0.15); drawGraph(); });
  elements.zoomOut.addEventListener('click', () => { state.zoom = Math.max(0.45, state.zoom - 0.15); drawGraph(); });
  elements.zoomReset.addEventListener('click', () => { state.zoom = 1; state.panX = 0; state.panY = 0; drawGraph(); });
}

async function init() {
  Object.assign(elements, {
    badge: document.getElementById('model-badge'),
    entityCount: document.getElementById('entity-count'),
    navigator: document.getElementById('navigator'),
    details: document.getElementById('details'),
    graph: document.getElementById('graph'),
    graphSubtitle: document.getElementById('graph-subtitle'),
    search: document.getElementById('entity-search'),
    synthetic: document.getElementById('show-synthetic'),
    section: document.getElementById('section-filter'),
    depth: document.getElementById('graph-depth'),
    zoomIn: document.getElementById('zoom-in'),
    zoomOut: document.getElementById('zoom-out'),
    zoomReset: document.getElementById('zoom-reset'),
  });
  readHash();
  bindEvents();
  try {
    const response = await fetch('/api/model');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.model = await response.json();
    state.entities = new Map(state.model.entities.map((entity) => [entity.name, entity]));
    if (!state.entities.has(state.selected)) {
      const preferred = state.model.entities.find((entity) => entity.name === 'product' && entity.recordEntity)
        || state.model.entities.find((entity) => entity.recordEntity)
        || state.model.entities[0];
      state.selected = preferred?.name || null;
    }
    elements.search.value = state.search;
    elements.synthetic.checked = state.showSynthetic;
    elements.section.value = state.section;
    elements.depth.value = String(state.depth);
    elements.badge.textContent = `Issue ${state.model.dialect || 'generic'} · ${state.model.stats.entities} entities`;
    renderNavigator();
    renderDetails();
    drawGraph();
    setHash();
  } catch (error) {
    elements.badge.textContent = 'Unable to load model';
    elements.details.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

window.addEventListener('DOMContentLoaded', init);
