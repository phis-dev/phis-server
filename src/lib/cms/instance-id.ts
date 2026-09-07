/**
 * The CMS node identity, as phi-server uses it.
 *
 * The encoding lives in `@phis/contracts/cms`: the site UI derives the same ids, and until 2026-09-07
 * both sides carried their own copy of it -- including `hashPresetIdentity`, line for line. Two
 * implementations of one arithmetic have no way of disagreeing loudly; they would simply have given
 * one process a different Page identity than the other.
 */
export {
  comparePhiCmsInstanceIds,
  createPhiDraftCmsInstanceId,
  createPhiPresetCmsInstanceId,
  isPhiCmsInstanceId,
  readPhiCmsInstanceId,
  readPhiCmsInstanceIdDescriptor,
  type PhiCmsInstanceDomain,
  type PhiCmsInstanceId,
  type PhiCmsInstanceIdDescriptor,
  type PhiCmsInstanceOrigin,
  type PhiCmsPresetInstanceIdentity,
} from "@phis/contracts/cms";
