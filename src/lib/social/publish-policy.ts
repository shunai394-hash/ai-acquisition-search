const SHARED_CREDENTIAL_PLATFORMS = ["instagram", "facebook", "youtube", "x"] as const;
type Platform = "tiktok" | "instagram" | "facebook" | "youtube" | "x" | "linkedin";

/**
 * Return platforms that must not publish through server-wide credentials
 * unless an operator explicitly enables single-tenant shared-account mode.
 */
export function blockedSharedCredentialPlatforms(platforms: Platform[], allowSharedAccounts: boolean) {
  if (allowSharedAccounts) return [];
  return platforms.filter((platform) =>
    (SHARED_CREDENTIAL_PLATFORMS as readonly string[]).includes(platform),
  );
}
