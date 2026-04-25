import { listBanks } from "./enablebanking.js";

/**
 * Registry of supported banks. Each entry maps a stable internal key
 * (used in the database and bot UI) to the parameters needed to find
 * the matching ASPSP entry from EnableBanking's /aspsps endpoint.
 *
 * `countries` is tried in order — the first country whose listBanks()
 * response contains a name that satisfies `matches` wins.
 */
export const SUPPORTED_BANKS = {
  intesa: {
    key: "intesa",
    displayName: "Intesa Sanpaolo",
    countries: ["IT"],
    matches: (name) => name.toLowerCase().includes("intesa"),
  },
  revolut: {
    key: "revolut",
    displayName: "Revolut",
    // Revolut Bank UAB is licensed in Lithuania (LT); GB is the fallback.
    countries: ["LT", "GB"],
    matches: (name) => name.toLowerCase().includes("revolut"),
  },
};

export function getBankConfig(bankKey) {
  const config = SUPPORTED_BANKS[bankKey];
  if (!config) throw new Error(`Unknown bank: ${bankKey}`);
  return config;
}

export function listSupportedBanks() {
  return Object.values(SUPPORTED_BANKS);
}

/**
 * Resolves a bank key to the EnableBanking ASPSP entry by searching
 * across the configured countries until a match is found.
 * @returns {Promise<{name: string, country: string}>}
 */
export async function resolveBank(appId, keyPath, bankKey) {
  const config = getBankConfig(bankKey);
  for (const country of config.countries) {
    const banks = await listBanks(appId, keyPath, country);
    const match = banks.find((b) => config.matches(b.name));
    if (match) return { name: match.name, country: match.country };
  }
  throw new Error(
    `${config.displayName} not found via EnableBanking (tried: ${config.countries.join(", ")})`
  );
}
