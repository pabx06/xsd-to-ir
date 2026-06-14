const crypto = require('crypto');

/**
 * sql-generator.js
 *
 * Consumes the Intermediate Representation produced by ir-builder.js and
 * emits MariaDB-compatible CREATE TABLE DDL statements.
 *
 * MariaDB-specific choices vs PostgreSQL:
 *   BIGSERIAL        → BIGINT AUTO_INCREMENT
 *   DOUBLE PRECISION → DOUBLE
 *   BYTEA            → LONGBLOB
 *   JSONB            → LONGTEXT  (MariaDB has JSON alias but LONGTEXT is portable)
 *   DEFAULT NOW()    → DEFAULT CURRENT_TIMESTAMP
 *   Inline REFERENCES → not supported; FKs via ALTER TABLE only
 *
 * Output order:
 *   1. Preamble (charset / engine directives)
 *   2. Enum / lookup tables
 *   3. Entity tables (leaf-first via topological sort so FKs are valid)
 *   4. Join tables
 *   5. Foreign-key ALTER TABLE statements
 *   6. Re-enable FK checks
 */

// ─── MariaDB type map (IR sqlType → MariaDB DDL type) ─────────────────────────

const MARIADB_TYPE = {
  BIGSERIAL: 'BIGINT', // AUTO_INCREMENT added on PK col
  BIGINT: 'BIGINT',
  INTEGER: 'INT',
  INT: 'INT',
  SMALLINT: 'SMALLINT',
  DECIMAL: 'DECIMAL(18,6)',
  FLOAT: 'FLOAT',
  'DOUBLE PRECISION': 'DOUBLE',
  DOUBLE: 'DOUBLE',
  BOOLEAN: 'TINYINT(1)', // no native BOOLEAN in MariaDB
  TEXT: 'TEXT',
  VARCHAR: 'VARCHAR(255)',
  'VARCHAR(64)': 'VARCHAR(64)',
  'VARCHAR(255)': 'VARCHAR(255)',
  'CHAR(4)': 'CHAR(4)',
  'CHAR(7)': 'CHAR(7)',
  'CHAR(10)': 'CHAR(10)',
  DATE: 'DATE',
  TIME: 'TIME',
  TIMESTAMP: 'DATETIME(3)', // DATETIME supports fractional seconds
  BYTEA: 'LONGBLOB',
  JSONB: 'LONGTEXT', // validate JSON in application layer
};

function _mariaType(sqlType) {
  return MARIADB_TYPE[sqlType] ?? sqlType;
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * @param {object} ir  The IR object returned by IRBuilder.build()
 * @returns {string}   Full SQL DDL string (MariaDB dialect)
 */
function generateSQL(ir) {
  const lines = [];

  lines.push('-- ================================================================');
  lines.push('-- AUTO-GENERATED FROM XSD — DO NOT EDIT BY HAND');
  lines.push('-- Target: MariaDB 10.4+');
  lines.push('-- ================================================================\n');

  lines.push('SET FOREIGN_KEY_CHECKS = 0;');
  lines.push('SET NAMES utf8mb4;\n');

  // 1. Enum lookup tables
  if (ir.enums.size > 0) {
    lines.push('-- ── Enum / lookup tables ───────────────────────────────────────────');
    for (const [, enumDef] of ir.enums) {
      lines.push(_enumTable(enumDef));
    }
  }

  // 2. Entity tables (topologically sorted so referenced tables come first)
  const sorted = _topoSort(ir.entities);
  lines.push('-- ── Entity tables ──────────────────────────────────────────────────');
  for (const entityName of sorted) {
    const entity = ir.entities.get(entityName);
    lines.push(_entityTable(entity));
  }

  // 3. Join tables
  if (ir.joinTables.size > 0) {
    lines.push('-- ── Join tables ────────────────────────────────────────────────────');
    for (const [, jt] of ir.joinTables) {
      lines.push(_joinTable(jt));
    }
  }

  // 4. Foreign-key constraints (after all tables exist)
  lines.push('-- ── Foreign-key constraints ────────────────────────────────────────');
  for (const entityName of sorted) {
    const entity = ir.entities.get(entityName);
    for (const col of entity.columns) {
      if (col.isForeignKey && col.referencesEntity) {
        const refEntity = ir.entities.get(col.referencesEntity);
        if (refEntity) {
          const fkName = _shortenIdentifier(`fk_${entity.tableName}_${col.columnName}`);
          lines.push(
            `ALTER TABLE \`${entity.tableName}\`\n`
            + `  ADD CONSTRAINT \`${fkName}\`\n`
            + `  FOREIGN KEY (\`${col.columnName}\`)\n`
            + `  REFERENCES \`${refEntity.tableName}\`(\`id\`)\n`
            + '  ON DELETE RESTRICT;\n',
          );
        }
      }
    }
  }

  lines.push('SET FOREIGN_KEY_CHECKS = 1;');

  return lines.join('\n');
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function _enumTable(enumDef) {
  const rows = enumDef.values.map((v) => `  ('${v.replace(/'/g, "''")}')`).join(',\n');
  return (
    `-- ${enumDef.name}\n`
    + `CREATE TABLE IF NOT EXISTS \`${enumDef.tableName}\` (\n`
    + '  `value` VARCHAR(64) NOT NULL PRIMARY KEY\n'
    + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n'
    + `INSERT IGNORE INTO \`${enumDef.tableName}\` (\`value\`) VALUES\n${rows};\n`
  );
}

function _entityTable(entity) {
  const colLines = entity.columns.map((col) => _columnDDL(col));

  const header = entity.documentation
    ? `-- ${entity.name}: ${entity.documentation}\n`
    : `-- ${entity.name}\n`;

  const tableSQL = `${header
  }CREATE TABLE IF NOT EXISTS \`${entity.tableName}\` (\n${
    colLines.map((l) => `  ${l}`).join(',\n')}\n`
    + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n';

  // Index on _msg_seq for fast delta queries
  const hasMsgSeq = entity.columns.some((c) => c.columnName === '_msg_seq');
  const indexes = [];
  if (hasMsgSeq) {
    const indexName = _shortenIdentifier(`idx_${entity.tableName}_msg_seq`);
    indexes.push(
      `CREATE INDEX IF NOT EXISTS \`${indexName}\``
      + ` ON \`${entity.tableName}\` (\`_msg_seq\`);`,
    );
  }

  const uidCol = entity.columns.find((c) => c.columnName === 'uid');
  if (uidCol) {
    const indexName = _shortenIdentifier(`idx_${entity.tableName}_uid`);
    indexes.push(
      `CREATE UNIQUE INDEX IF NOT EXISTS \`${indexName}\``
      + ` ON \`${entity.tableName}\` (\`uid\`);`,
    );
  }

  return tableSQL + (indexes.length > 0 ? `${indexes.join('\n')}\n` : '');
}

function _columnDDL(col) {
  const mariaType = _mariaType(col.sqlType);
  const parts = [`\`${col.columnName}\``.padEnd(34), mariaType];
  const checks = [];

  if (col.isPrimaryKey) {
    // MariaDB auto-increment PK syntax
    parts.push('NOT NULL AUTO_INCREMENT PRIMARY KEY');
  } else {
    if (col.columnName === '_created_at') {
      parts.push('NOT NULL DEFAULT CURRENT_TIMESTAMP');
    } else if (col.columnName === '_updated_at') {
      parts.push('NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
    } else if (col.columnName === '_msg_seq') {
      parts.push('NOT NULL DEFAULT 0');
    } else {
      if (!col.nullable) {
        parts.push('NOT NULL');
      } else if (!_hasDefault(col)) {
        parts.push('DEFAULT NULL');
      }

      if (_hasDefault(col)) {
        parts.push(`DEFAULT ${_sqlLiteral(col.defaultValue)}`);
      }
    }

    if (col.isEnum && col.enumRef) {
      const vals = (col.constraints.enum || []).map((v) => _sqlLiteral(v)).join(', ');
      if (vals) checks.push(`CHECK (\`${col.columnName}\` IN (${vals}))`);
    }

    if (_needsJsonValidityCheck(col)) {
      const nullableClause = col.nullable ? `\`${col.columnName}\` IS NULL OR ` : '';
      checks.push(`CHECK (${nullableClause}JSON_VALID(\`${col.columnName}\`))`);
    }
  }

  if (col.documentation) {
    parts.push(`COMMENT '${col.documentation.replace(/'/g, "''").slice(0, 1024)}'`);
  }

  parts.push(...checks);

  return parts.join(' ');
}

function _hasDefault(col) {
  return col.defaultValue !== undefined && col.defaultValue !== null;
}

function _sqlLiteral(value) {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function _needsJsonValidityCheck(col) {
  return col.sqlType === 'LONGTEXT' && col.jsonType === 'object';
}

function _joinTable(jt) {
  return (
    `-- ${jt.documentation || jt.name}\n`
    + `CREATE TABLE IF NOT EXISTS \`${jt.tableName}\` (\n${
      `  \`${jt.leftColumn}\``.padEnd(36)} BIGINT NOT NULL,\n${
      `  \`${jt.rightColumn}\``.padEnd(36)} BIGINT NOT NULL,\n`
    + `  PRIMARY KEY (\`${jt.leftColumn}\`, \`${jt.rightColumn}\`)\n`
    + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n'
  );
}

function _shortenIdentifier(name, maxLength = 64) {
  if (!name || name.length <= maxLength) return name;

  const hash = crypto.createHash('sha1').update(name).digest('hex').slice(0, 10);
  const prefixLength = maxLength - hash.length - 1;
  const prefix = name.slice(0, prefixLength).replace(/_+$/g, '');
  return `${prefix}_${hash}`;
}

/**
 * Kahn's algorithm: entities referenced by FK come first.
 */
function _topoSort(entities) {
  const indegree = new Map([...entities.keys()].map((k) => [k, 0]));
  const deps = new Map([...entities.keys()].map((k) => [k, new Set()]));

  for (const [name, entity] of entities) {
    for (const col of entity.columns) {
      if (col.isForeignKey && col.referencesEntity && entities.has(col.referencesEntity)) {
        deps.get(name).add(col.referencesEntity);
        indegree.set(name, (indegree.get(name) || 0) + 1);
      }
    }
  }

  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([k]) => k);
  const result = [];

  while (queue.length > 0) {
    const node = queue.shift();
    result.push(node);
    for (const [name, depSet] of deps) {
      if (depSet.has(node)) {
        depSet.delete(node);
        const newDeg = (indegree.get(name) || 1) - 1;
        indegree.set(name, newDeg);
        if (newDeg === 0) queue.push(name);
      }
    }
  }

  // Append any remaining (cycles) at the end
  for (const k of entities.keys()) {
    if (!result.includes(k)) result.push(k);
  }

  return result;
}

module.exports = { generateSQL };
