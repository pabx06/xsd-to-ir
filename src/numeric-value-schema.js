const integer = '[+-]?[0-9]+';
const decimal = '[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)';
const floating = `(?:${decimal}(?:[eE][+-]?[0-9]+)?|[+-]?INF|NaN)`;
const bounds = {
  minimum: 'minimum', maximum: 'maximum', minInclusive: 'minimum', maxInclusive: 'maximum',
  minExclusive: 'exclusiveMinimum', maxExclusive: 'exclusiveMaximum',
};

const trim = (value) => String(value).replace(/^[\t\r\n ]+|[\t\r\n ]+$/g, '');
const isFloating = (kind) => ['float', 'double'].includes(kind);
// Unlike $, this end assertion cannot match before a final newline. Boundary
// XML whitespace is explicit because union members can retain their raw text.
const anchored = (pattern) => `^[\\t\\r\\n ]*(?:${pattern})[\\t\\r\\n ]*(?![\\s\\S])`;
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function decimalKey(value) {
  const match = /^([+-]?)([0-9]*)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$/.exec(value);
  if (!match || !(match[2] || match[3])) return null;
  const fraction = match[3] || '';
  const digits = `${match[2]}${fraction}`.replace(/^0+/, '');
  if (!digits) return '0';
  const significant = digits.replace(/0+$/, '');
  const exponent = BigInt(match[4] || 0) + BigInt(digits.length - significant.length - fraction.length);
  return `${match[1] === '-' ? '-' : ''}${significant}e${exponent}`;
}

/** Keep a constant lexical when converting it to a JS number would change its value. */
function numericValue(value, kind) {
  const text = trim(value);
  const key = decimalKey(text);
  const number = Number(text);
  if (key !== null && Number.isFinite(number)
      && (isFloating(kind) || key === decimalKey(String(number)))) return number;
  return text;
}

function equivalentPattern(value, kind, warnings) {
  const text = trim(value);
  const match = /^([+-]?)([0-9]*)(?:\.([0-9]*))?$/.exec(text);
  if (!match || !(match[2] || match[3])) {
    if (isFloating(kind)) warnings.add('Alternate floating-point enum/fixed spellings require XSD validation.');
    return escaped(text);
  }
  const whole = match[2].replace(/^0+/, '') || '0';
  const fraction = (match[3] || '').replace(/0+$/, '');
  const zero = whole === '0' && !fraction;
  if (zero) return kind === 'integer' ? '[+-]?0+' : '[+-]?(?:0+(?:\\.0*)?|\\.0+)';
  const sign = match[1] === '-' ? '-' : '\\+?';
  if (kind === 'integer') return `${sign}0*${whole}`;
  const body = whole === '0' ? `0*\\.${fraction}0*`
    : `0*${whole}${fraction ? `\\.${fraction}0*` : '(?:\\.0*)?'}`;
  if (isFloating(kind)) warnings.add('Alternate floating-point enum/fixed spellings require XSD validation.');
  return `${sign}${body}${isFloating(kind) ? '(?:[eE][+-]?0+)?' : ''}`;
}

function numericChoices(values, use, warnings) {
  const kind = use.numericKind || (use.jsonType === 'integer' ? 'integer' : 'decimal');
  const numbers = [...new Set(values.map((value) => numericValue(value, kind))
    .filter((value) => typeof value === 'number'))];
  const lexical = {
    type: 'string',
    anyOf: [...new Set(values.map((value) => equivalentPattern(value, kind, warnings)))]
      .map((pattern) => ({ pattern: anchored(pattern) })),
  };
  return { anyOf: [...(numbers.length ? [{ type: use.jsonType, enum: numbers }] : []), lexical] };
}

/** Numeric JSON values and exact XML lexical values share one portable schema. */
function numericSchema(schema, use, warnings) {
  const kind = use.numericKind || (use.jsonType === 'integer' ? 'integer' : 'decimal');
  const lexical = { type: 'string', pattern: anchored(kind === 'integer' ? integer : decimal) };
  if (isFloating(kind)) lexical.pattern = anchored(floating);
  // Numeric keywords do not constrain strings; preserve translated XSD patterns
  // separately so adding lexical values cannot bypass those restrictions.
  const patterns = schema.pattern ? { pattern: schema.pattern } : schema.anyOf && { anyOf: schema.anyOf };
  if (patterns) lexical.allOf = [patterns];
  const facets = {};
  for (const [source, target] of Object.entries(bounds)) {
    if (use.constraints[source] === undefined) continue;
    facets[source] = use.constraints[source];
    const value = numericValue(use.constraints[source], kind);
    if (typeof value === 'number') schema[target] = value;
    else {
      delete schema[target];
      warnings.add(`Exact numeric ${source} would round when serialized by this generator; requires XSD validation.`);
    }
  }
  for (const key of ['totalDigits', 'fractionDigits']) {
    if (use.constraints[key] !== undefined) facets[key] = use.constraints[key];
  }
  if (Object.keys(facets).length) {
    lexical['x-xsd-facets'] = facets;
    warnings.add('Numeric bounds and digit facets on lexical strings require XSD validation.');
  }
  // Use value-space equality for integer/decimal declarations, without coercing
  // exact constants through Number or restricting strings to one spelling.
  delete schema.enum;
  const result = { anyOf: [schema, lexical] };
  if (use.constraints.enum) {
    result.allOf = [numericChoices(use.constraints.enum, use, warnings)];
    result['x-xsd-enumeration'] = use.constraints.enum;
  }
  return result;
}

module.exports = { numericSchema, numericChoices, numericValue };
