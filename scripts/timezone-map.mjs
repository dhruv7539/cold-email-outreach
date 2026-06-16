// State -> IANA timezone resolution + zoned wall-clock helpers.
//
// Used by the exporter to stamp each Queue row with a `recipient_timezone`
// (so the Apps Script runtime can gate each send to the recipient's local
// business hours) and to schedule absolute send instants in that local zone.
//
// State-level granularity is intentional: Apollo enrichment reliably gives us
// a US state, rarely a precise city/tz. We pick the dominant zone per state.
// AZ is mapped to America/Phoenix (no DST) on purpose. States that straddle
// zones (e.g. parts of TN, FL, ID) use the more populous zone.

export const DEFAULT_TIMEZONE = "America/Los_Angeles";

// Full state name -> IANA zone. Two-letter abbreviations are derived below.
export const STATE_TO_TIMEZONE = {
  Alabama: "America/Chicago",
  Alaska: "America/Anchorage",
  Arizona: "America/Phoenix",
  Arkansas: "America/Chicago",
  California: "America/Los_Angeles",
  Colorado: "America/Denver",
  Connecticut: "America/New_York",
  Delaware: "America/New_York",
  "District of Columbia": "America/New_York",
  Florida: "America/New_York",
  Georgia: "America/New_York",
  Hawaii: "Pacific/Honolulu",
  Idaho: "America/Boise",
  Illinois: "America/Chicago",
  Indiana: "America/Indiana/Indianapolis",
  Iowa: "America/Chicago",
  Kansas: "America/Chicago",
  Kentucky: "America/New_York",
  Louisiana: "America/Chicago",
  Maine: "America/New_York",
  Maryland: "America/New_York",
  Massachusetts: "America/New_York",
  Michigan: "America/Detroit",
  Minnesota: "America/Chicago",
  Mississippi: "America/Chicago",
  Missouri: "America/Chicago",
  Montana: "America/Denver",
  Nebraska: "America/Chicago",
  Nevada: "America/Los_Angeles",
  "New Hampshire": "America/New_York",
  "New Jersey": "America/New_York",
  "New Mexico": "America/Denver",
  "New York": "America/New_York",
  "North Carolina": "America/New_York",
  "North Dakota": "America/Chicago",
  Ohio: "America/New_York",
  Oklahoma: "America/Chicago",
  Oregon: "America/Los_Angeles",
  Pennsylvania: "America/New_York",
  "Rhode Island": "America/New_York",
  "South Carolina": "America/New_York",
  "South Dakota": "America/Chicago",
  Tennessee: "America/Chicago",
  Texas: "America/Chicago",
  Utah: "America/Denver",
  Vermont: "America/New_York",
  Virginia: "America/New_York",
  Washington: "America/Los_Angeles",
  "West Virginia": "America/New_York",
  Wisconsin: "America/Chicago",
  Wyoming: "America/Denver",
  "Puerto Rico": "America/Puerto_Rico",
};

const ABBREV_TO_STATE = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  PR: "Puerto Rico",
};

// Resolve a US state (full name or 2-letter abbreviation) to an IANA zone.
// Returns null when the state is missing/unrecognized so callers can fall
// back to a default.
export function resolveTimezoneFromState(state) {
  const raw = String(state ?? "").trim();
  if (!raw) return null;
  if (STATE_TO_TIMEZONE[raw]) return STATE_TO_TIMEZONE[raw];
  const upper = raw.toUpperCase();
  if (ABBREV_TO_STATE[upper]) return STATE_TO_TIMEZONE[ABBREV_TO_STATE[upper]];
  // Title-case fallback ("new york" -> "New York").
  const titled = raw
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return STATE_TO_TIMEZONE[titled] ?? null;
}

// Offset (ms) such that local_wall_clock = utc_instant + offset, for `timeZone`
// at the moment `date`. Computed via Intl so DST is handled correctly.
export function getZoneOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
  return asUtc - date.getTime();
}

// Convert a wall-clock time in `timeZone` to the absolute UTC Date.
// Two-step resolution: guess the instant treating the wall clock as UTC, then
// correct by the zone offset at that instant. Good enough for business-hours
// scheduling (the only ambiguity is the ~1h DST transition window).
export function zonedWallClockToUtc(
  year,
  month,
  day,
  hour,
  minute,
  timeZone
) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = getZoneOffsetMs(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offset);
}

// The local Y/M/D in `timeZone` for a given absolute instant.
export function zonedDateParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const map = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    weekday: map.weekday, // "Mon".."Sun"
  };
}
