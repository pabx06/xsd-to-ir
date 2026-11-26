const NAMESPACES = {
  '@_xmlns:s': 'http://www.asd-europe.org/s-series/s3000l',
  '@_xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
};

// The Issue 1.1 XSD requires all five wrappers even for an empty database.
const ISSUE_11_PRIMARY = {
  products: {}, breakdownElements: {}, parts: {}, taskRequirements: {}, tasks: {},
};

function buildEnvelope(version, options, primary, supporting) {
  const {
    msgId = `MSG-${Date.now()}`, msgStatus = 'F', msgType, relatedMsgId, sendingSystem, receivingSystem,
  } = options;
  const dateTime = new Date(options.msgDate ?? Date.now()).toISOString();
  const header = { ...NAMESPACES, msgId: { id: msgId } };
  const related = relatedMsgId ? { relatedMsg: { msgRef: { msgId: { id: relatedMsgId } } } } : {};
  // The exchange schemas identify parties by organization reference.
  const organization = (id) => ({ orgRef: { orgId: { id } } });
  const declaration = { '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' } };

  if (version === '1.1') {
    return {
      ...declaration,
      's:lsaDataSet': {
        ...header,
        msgDate: { dateTime },
        msgStatus: { code: msgStatus },
        ...(sendingSystem ? { msgSend: organization(sendingSystem) } : {}),
        ...(receivingSystem ? { msgReceive: organization(receivingSystem) } : {}),
        msgContent: {
          messageContentItems: { ...ISSUE_11_PRIMARY, ...primary },
          supportingContentItems: supporting,
        },
        ...related,
      },
    };
  }
  const parties = [[sendingSystem, 'S'], [receivingSystem, 'R']]
    .filter(([id]) => id)
    .map(([id, code]) => ({ ptyType: { code }, party: organization(id) }));
  return {
    ...declaration,
    's:lsaDataset': {
      ...header,
      msgDate: { date: dateTime.slice(0, 10), time: dateTime.slice(11) },
      msgStatus: { state: msgStatus },
      msgType: { code: msgType },
      logisticsSupportAnalysisData: {
        ...(Object.keys(primary).length ? { lsaPrimaryData: primary } : {}),
        ...(Object.keys(supporting).length ? { lsaSupportingData: supporting } : {}),
      },
      ...(parties.length ? { msgPty: parties } : {}),
      ...related,
    },
  };
}

module.exports = { buildEnvelope };
