export interface SmokeTextPayloadOptions {
  projectName: string;
  projectUuid: string;
  documentUuid: string;
  marker: string;
}

export function smokeTextPayload(options: SmokeTextPayloadOptions): string {
  return `
const expected = ${JSON.stringify(options)};
const marker = expected.marker;
async function guardDocument() {
  const project = await eda.dmt_Project.getCurrentProjectInfo();
  const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  if (project?.friendlyName !== expected.projectName || project?.uuid !== expected.projectUuid ||
      document?.uuid !== expected.documentUuid) throw Error("DOCUMENT_GUARD");
}
await guardDocument();
const before = (await eda.sch_PrimitiveText.getAllPrimitiveId()).slice().sort();
let createdId;
let observed = false;
let deleted = false;
let failure = null;
let cleanupFailure = null;
try {
  const text = await eda.sch_PrimitiveText.create(100, 100, marker);
  createdId = text?.getState_PrimitiveId();
  if (!createdId) throw Error("CREATE_UNCONFIRMED");
  await guardDocument();
  observed = (await eda.sch_PrimitiveText.get(createdId))?.getState_Content() === marker;
  if (!observed) throw Error("READBACK_FAILED");
} catch (error) {
  failure = String(error);
} finally {
  if (createdId) {
    try {
      await guardDocument();
      deleted = await eda.sch_PrimitiveText.delete(createdId);
      if (!deleted || await eda.sch_PrimitiveText.get(createdId)) throw Error("CLEANUP_UNCONFIRMED");
    } catch (error) {
      cleanupFailure = String(error);
    }
  }
}
let after;
try {
  await guardDocument();
  after = (await eda.sch_PrimitiveText.getAllPrimitiveId()).slice().sort();
} catch (error) {
  failure ??= String(error);
}
const restored = after !== undefined && JSON.stringify(before) === JSON.stringify(after);
return {marker, createdId, observed, deleted, failure, cleanupFailure,
        beforeCount:before.length, afterCount:after?.length ?? null, restored};
`;
}
