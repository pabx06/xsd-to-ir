class DBRelationResolver {
  constructor({ entityForName, activeByUid }) {
    this.entityForName = entityForName;
    this.activeByUid = activeByUid;
  }

  async resolveParentRef(row, trx) {
    if (!row?._xmlParent) return row;

    const { _xmlParent, ...clean } = row;
    const parentEntity = this.entityForName(_xmlParent.entityName);
    if (!_xmlParent.uid) {
      throw new Error(
        `Cannot resolve parent FK ${_xmlParent.fkColumn}: parent uid is missing`,
      );
    }

    const parent = await this.activeByUid(parentEntity, _xmlParent.uid, trx);

    if (!parent) {
      throw new Error(
        `Cannot resolve parent FK ${_xmlParent.fkColumn}: `
        + `${_xmlParent.entityName} uid "${_xmlParent.uid}" was not found`,
      );
    }

    clean[_xmlParent.fkColumn] = parent.id;
    return clean;
  }

  queueRelationRefs(queue, entityName, sourceId, refs) {
    if (!refs || refs.length === 0) return;
    queue.push({ entityName, sourceId, refs });
  }

  async applyPendingRelationRefs(pendingRelations, trx) {
    for (const pending of pendingRelations) {
      await this.applyRelationRefs(pending, trx);
    }
  }

  async applyRelationRefs(pending, trx) {
    const sourceEntity = this.entityForName(pending.entityName);
    const payload = {};

    for (const ref of pending.refs) {
      const targetEntity = this.entityForName(ref.entityName);
      const target = await this.activeByUid(targetEntity, ref.uid, trx);
      if (!target) {
        throw new Error(
          `Cannot resolve relation FK ${pending.entityName}.${ref.fkColumn}: `
          + `${ref.entityName} uid "${ref.uid}" was not found`,
        );
      }
      payload[ref.fkColumn] = target.id;
    }

    if (Object.keys(payload).length === 0) return;
    await trx(sourceEntity.tableName)
      .where('id', pending.sourceId)
      .update(payload);
  }
}

module.exports = { DBRelationResolver };
