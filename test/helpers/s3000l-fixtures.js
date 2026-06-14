function s3000lEnvelope({
  msgId = 'MSG-IN',
  msgDate = '2026-06-13',
  msgType = 'B',
  msgStatus = null,
  primary = '',
  supporting = '',
} = {}) {
  const primaryData = primary ? `<lsaPrimaryData>${primary}</lsaPrimaryData>` : '';
  const supportingData = supporting ? `<lsaSupportingData>${supporting}</lsaSupportingData>` : '';
  const status = msgStatus ? `<msgStatus><code>${msgStatus}</code></msgStatus>` : '';

  return [
    '<lsaDataset>',
    `<msgId>${msgId}</msgId>`,
    `<msgDate>${msgDate}</msgDate>`,
    `<msgType><code>${msgType}</code></msgType>`,
    status,
    '<logisticsSupportAnalysisData>',
    primaryData,
    supportingData,
    '</logisticsSupportAnalysisData>',
    '</lsaDataset>',
  ].join('');
}

function relationshipHeavyPrimaryXml(msgId = 'MSG-REL-IN') {
  return s3000lEnvelope({
    msgId,
    primary: [
      '<products><prod uid="prod1" crud="I">',
      '<prodId><id>PROD-1</id></prodId>',
      '<prodVar uid="prodv1" crud="I"><prodVarId><id>PV-1</id></prodVarId></prodVar>',
      '<prodVar uid="prodv2" crud="I"><prodVarId><id>PV-2</id></prodVarId></prodVar>',
      '</prod></products>',
      '<tasks><opTask uid="task1" crud="I">',
      '<taskId><id>TASK-1</id></taskId>',
      '<taskRev uid="taskrev1" crud="I">',
      '<revId><id>REV-1</id></revId>',
      '<subtByDef uid="subt1" crud="I"><subtId><id>SUBT-1</id></subtId></subtByDef>',
      '<taskJust uid="taskjust1" crud="I"><trRevRef uidRef="trrev1"/></taskJust>',
      '</taskRev>',
      '</opTask></tasks>',
    ].join(''),
  });
}

function relationshipHeavyRoundTripXml(msgId = 'MSG-ROUNDTRIP-IN') {
  return s3000lEnvelope({
    msgId,
    msgStatus: 'F',
    primary: [
      '<products>',
      '<prod uid="prod1" crud="I">',
      '<prodId><id>PROD-1</id></prodId>',
      '<prodName><name>Round Trip Product</name></prodName>',
      '<prodVar uid="prodv1" crud="I">',
      '<prodVarId><id>PV-1</id></prodVarId>',
      '<prodVarName><name>Round Trip Variant</name></prodVarName>',
      '</prodVar>',
      '</prod>',
      '</products>',
      '<tasks>',
      '<opTask uid="task1" crud="I">',
      '<taskId><id>TASK-1</id></taskId>',
      '<taskRev uid="taskrev1" crud="I">',
      '<revId><id>REV-1</id></revId>',
      '<taskName><name>Round Trip Task Revision</name></taskName>',
      '<subtByDef uid="subt1" crud="I"><subtId><id>SUBT-1</id></subtId></subtByDef>',
      '<taskJust uid="taskjust1" crud="I"><trRevRef uidRef="trrev1"/></taskJust>',
      '</taskRev>',
      '</opTask>',
      '</tasks>',
    ].join(''),
    supporting: [
      '<facilities>',
      '<maintFclty uid="fclty1" crud="I">',
      '<fcltyId><id>FCLTY-1</id></fcltyId>',
      '<fcltyName><name>Round Trip Facility</name></fcltyName>',
      '<fcltyRel uid="fcltyrel1" crud="I">',
      '<relType><code>SUPPORTS</code></relType>',
      '<facilityRef uidRef="fclty2"/>',
      '</fcltyRel>',
      '<InfrStrCompls><customFlag>Y</customFlag></InfrStrCompls>',
      '</maintFclty>',
      '</facilities>',
    ].join(''),
  });
}

function relationshipMissingParentUidXml(msgId = 'MSG-REL-MISSING-PARENT-UID') {
  return s3000lEnvelope({
    msgId,
    primary: [
      '<products><prod crud="I">',
      '<prodId><id>PROD-1</id></prodId>',
      '<prodVar uid="prodv1" crud="I"><prodVarId><id>PV-1</id></prodVarId></prodVar>',
      '</prod></products>',
    ].join(''),
  });
}

function relationshipMissingChoiceBranchUidXml(msgId = 'MSG-REL-MISSING-BRANCH-UID') {
  return s3000lEnvelope({
    msgId,
    primary: [
      '<tasks><opTask uid="task1" crud="I">',
      '<taskId><id>TASK-1</id></taskId>',
      '<taskRev uid="taskrev1" crud="I">',
      '<revId><id>REV-1</id></revId>',
      '<subtByDef crud="I"><subtId><id>SUBT-1</id></subtId></subtByDef>',
      '</taskRev>',
      '</opTask></tasks>',
    ].join(''),
  });
}

function relationshipUnsupportedChoiceBranchXml(msgId = 'MSG-REL-UNSUPPORTED-BRANCH') {
  return s3000lEnvelope({
    msgId,
    primary: [
      '<tasks><opTask uid="task1" crud="I">',
      '<taskId><id>TASK-1</id></taskId>',
      '<taskRev uid="taskrev1" crud="I">',
      '<revId><id>REV-1</id></revId>',
      '<subtByDef>not-a-record</subtByDef>',
      '</taskRev>',
      '</opTask></tasks>',
    ].join(''),
  });
}

module.exports = {
  relationshipHeavyPrimaryXml,
  relationshipHeavyRoundTripXml,
  relationshipMissingChoiceBranchUidXml,
  relationshipMissingParentUidXml,
  relationshipUnsupportedChoiceBranchXml,
  s3000lEnvelope,
};
