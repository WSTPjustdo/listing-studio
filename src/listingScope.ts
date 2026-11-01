import type { Listing } from "./types";

/** Saved plan/snapshot determine the historical market; the current dropdown does not. */
export function listingScope(record?: Listing | null) {
  return {
    marketplace: record?.guided_plan?.marketplace || record?.rule_pack_snapshot?.scope?.marketplace || record?.marketplace || "US",
    language: record?.language || record?.guided_plan?.language || "en",
  };
}
