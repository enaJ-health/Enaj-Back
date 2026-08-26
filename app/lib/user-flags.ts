// ==========================================
// Encrypted user-flag resolution
// ==========================================
// Fetches a user's UserAilment/UserPreference/UserJournalEntry rows by
// their plaintext userId (unchanged, still indexed — userId itself is
// never encrypted), decrypts each row's encrypted catalog-id field in
// app code, then looks up the corresponding Ailment/Preference/
// JournalCondition catalog rows by the decrypted id. The public catalog
// tables stay plaintext/indexed throughout — only the user's *selection*
// of which catalog entries apply to them is encrypted at rest.
//
// Rows whose *Enc field is still null (not yet backfilled by
// scripts/encrypt-existing-data.ts) fall back to the original plaintext
// `<field>Id` column, which every row - pre- or post-migration - still
// has populated; only a custom-entry-only row (no catalog id at all) is
// skipped.
//
// Returns data shaped exactly for ailmentsToFlagInputs /
// preferencesToFlagInputs / journalEntriesToFlagInputs in
// app/lib/scan-product.ts, which is otherwise unchanged.
// ==========================================

import { prisma } from "@/app/lib/prisma";
import { decryptField } from "@/app/lib/crypto";
import {
  ailmentsToFlagInputs,
  preferencesToFlagInputs,
  journalEntriesToFlagInputs,
  type AilmentFlagInput,
  type PreferenceFlagInput,
  type JournalFlagInput,
} from "@/app/lib/scan-product";

export interface UserFlagSources {
  ailments: AilmentFlagInput[];
  preferences: PreferenceFlagInput[];
  journalEntries: JournalFlagInput[];
}

export interface GetUserFlagSourcesOptions {
  // Matches the [slug]/scan route's deeper include (flaggedIngredients
  // with their IngredientSource citations). The products list route
  // does not include these, so this defaults to false to keep that
  // route's response shape unchanged.
  includeIngredientSources?: boolean;
}

/** Decrypts a payload, logging and returning null instead of throwing
 * on a corrupt/undecryptable row so one bad row can't fail an entire
 * request. */
function safeDecrypt(payload: string | null | undefined): string | null {
  if (!payload) return null;
  try {
    return decryptField(payload);
  } catch (err) {
    console.error("user-flags: failed to decrypt an encrypted field, skipping row", err);
    return null;
  }
}

function uniqueNonNull(values: (string | null)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v)));
}

export async function getUserFlagSources(
  userId: string,
  options: GetUserFlagSourcesOptions = {}
): Promise<UserFlagSources> {
  const { includeIngredientSources = false } = options;

  const [userAilmentRows, userPreferenceRows, userJournalRows] = await Promise.all([
    prisma.userAilment.findMany({
      where: { userId, OR: [{ ailmentIdEnc: { not: null } }, { ailmentId: { not: null } }] },
      select: { ailmentId: true, ailmentIdEnc: true },
    }),
    prisma.userPreference.findMany({
      where: { userId, OR: [{ preferenceIdEnc: { not: null } }, { preferenceId: { not: null } }] },
      select: { preferenceId: true, preferenceIdEnc: true },
    }),
    prisma.userJournalEntry.findMany({
      where: { userId, OR: [{ conditionIdEnc: { not: null } }, { conditionId: { not: null } }] },
      select: { conditionId: true, conditionIdEnc: true },
    }),
  ]);

  const ailmentIds = uniqueNonNull(
    userAilmentRows.map((r) => (r.ailmentIdEnc ? safeDecrypt(r.ailmentIdEnc) : r.ailmentId))
  );
  const preferenceIds = uniqueNonNull(
    userPreferenceRows.map((r) => (r.preferenceIdEnc ? safeDecrypt(r.preferenceIdEnc) : r.preferenceId))
  );
  const conditionIds = uniqueNonNull(
    userJournalRows.map((r) => (r.conditionIdEnc ? safeDecrypt(r.conditionIdEnc) : r.conditionId))
  );

  const ailments = ailmentIds.length
    ? includeIngredientSources
      ? await prisma.ailment.findMany({
          where: { id: { in: ailmentIds } },
          include: { flaggedIngredients: { include: { sources: true } } },
        })
      : await prisma.ailment.findMany({
          where: { id: { in: ailmentIds } },
          include: { flaggedIngredients: true },
        })
    : [];

  const preferences = preferenceIds.length
    ? await prisma.preference.findMany({ where: { id: { in: preferenceIds } } })
    : [];

  const journalConditions = conditionIds.length
    ? await prisma.journalCondition.findMany({ where: { id: { in: conditionIds } } })
    : [];

  return {
    ailments: ailmentsToFlagInputs(ailments.map((ailment) => ({ ailment }))),
    preferences: preferencesToFlagInputs(preferences.map((preference) => ({ preference }))),
    journalEntries: journalEntriesToFlagInputs(journalConditions.map((condition) => ({ condition }))),
  };
}
