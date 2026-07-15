// Shared query-building helpers for the API job sources (jsearch, adzuna, serpapi).
//
// Every role string used to search these APIs derives from the user's configured
// target roles — config.requiredTitleKeywords, which loadConfig() populates from
// config/profile.yml's `target_roles`. There are NO hardcoded personal role
// families here: when a user has not configured any target roles, the sources
// skip rather than search someone else's roles.

// Returns the configured target-role list (trimmed, non-empty strings), or an
// empty array when none are set. Sources treat [] as "skip this source".
export function resolveTargetRoles(config) {
  const roles = config?.requiredTitleKeywords;
  if (!Array.isArray(roles)) return [];
  return roles.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim());
}

// Chunk roles into OR-joined query groups (e.g. "a OR b OR c OR d"). Sources that
// support boolean OR (JSearch and SerpAPI/Google Jobs) send a handful of these
// instead of one request per role, to stay within request quotas. Returns [] when
// there are no roles.
export function buildRoleGroups(roles, perGroup = 4) {
  const groups = [];
  for (let i = 0; i < roles.length; i += perGroup) {
    groups.push(roles.slice(i, i + perGroup).join(' OR '));
  }
  return groups;
}

// Build a SerpAPI / Google Jobs location string from a configured location entry,
// mapping only what the profile actually declares (city, plus region when present).
// No fixed city map is baked in — the strings come from config.locations.
export function serpApiLocationString(loc) {
  if (!loc?.city) return '';
  return loc.region ? `${loc.city}, ${loc.region}` : loc.city;
}
