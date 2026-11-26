function list(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function annotationText(node) {
  if (typeof node === 'string') return node.trim();
  if (!node || typeof node !== 'object') return '';
  return Object.entries(node).filter(([key]) => !key.startsWith('@_'))
    .flatMap(([, value]) => list(value).map(annotationText)).filter(Boolean)
    .join(' ');
}

/** Retain per-code annotations, including Issue 2.0's appinfo/source wrapper. */
function extractEnumAnnotations(restriction, inherited = {}) {
  const values = list(restriction.enumeration);
  if (!values.length) return inherited;
  return Object.fromEntries(values.map((value) => {
    const code = value['@_value'];
    const annotations = list(value.annotation);
    const appInfo = annotations.flatMap((item) => list(item.appinfo).map(annotationText)).filter(Boolean);
    const documentation = annotations.flatMap((item) => list(item.documentation).map(annotationText)).filter(Boolean);
    const metadata = {
      ...(Object.hasOwn(inherited, code) ? inherited[code] : {}),
      ...(appInfo.length ? { appInfo } : {}),
      ...(documentation.length ? { documentation } : {}),
    };
    return [code, metadata];
  }).filter(([code, metadata]) => code !== undefined && Object.keys(metadata).length));
}

module.exports = { extractEnumAnnotations };
