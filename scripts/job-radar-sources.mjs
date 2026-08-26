// Job Radar sources (2026-08-21) — one adapter per Apify actor.
//
// Each source maps a different actor's raw output into ONE normalized job shape
// so scripts/job-radar.mjs stays source-agnostic. Verified output shapes on
// 2026-08-21 via tiny capped REST runs (output/jobs/verify/*.items.json).
//
// Normalized job shape:
//   { id, title, company, url, posted, location, arrangement, exp, salary,
//     size, source, description, skills[], countries[], remote, remoteLocations[] }
// `sponsorship` is computed by the runner from `description`.
//
// Sources:
//   career    fantastic-jobs/career-site-job-listing-api  (ATS/career sites)
//   jobspy    openclawai/job-board-scraper                 (LinkedIn/Indeed/Glassdoor/ZipRecruiter/Google)
//   wellfound clearpath/wellfound-api-ppe                  (startups; DataDome, residential proxy)
//   dice      blackfalcondata/dice-com-job-scraper         (US tech)
//   handshake parsebird/handshake-jobs-scraper             (public listings only)
//   jobright  jobscrawler/jobright-scraper                 (mock data as of 2026-08-21 — disabled)

// ---- text / value helpers --------------------------------------------------

const US_STATE_ABBR = new Set([
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il",
  "in", "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "mo", "mt",
  "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri",
  "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy", "dc",
]);
const US_SIGNALS = ["united states", "usa", "u.s.", "u.s ", "america", "remote, us", "remote - us", "us remote"];
const FOREIGN_SIGNALS = [
  "india", "united kingdom", " uk", "canada", "germany", "france", "australia",
  "bangladesh", "pakistan", "philippines", "singapore", "ireland", "netherlands",
  "spain", "brazil", "mexico", "poland", "romania", "ukraine", "nigeria", "kenya",
  "egypt", "dubai", "uae", "emea", "apac", "latam", "china", "japan", "korea",
];

function stripToText(s) {
  if (!s) return "";
  return String(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/[#*_`>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);
}

function fmtK(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "";
  return v >= 1000 ? `${Math.round(v / 1000)}K` : `${v}`;
}

function normalizeInterval(interval) {
  const s = String(interval || "").toLowerCase();
  if (!s) return "";
  if (s.startsWith("year") || s === "yr" || s === "annual") return "/yr";
  if (s.startsWith("hour") || s === "hr") return "/hr";
  if (s.startsWith("month")) return "/mo";
  if (s.startsWith("week")) return "/wk";
  if (s.startsWith("day")) return "/day";
  return `/${s}`;
}

function salaryLabel({ min, max, value, currency, interval } = {}) {
  const cur = currency ? (currency === "USD" ? "$" : `${currency} `) : "";
  const unit = normalizeInterval(interval);
  const lo = fmtK(min);
  const hi = fmtK(max);
  const v = fmtK(value);
  if (lo && hi) return `${cur}${lo}-${hi}${unit}`;
  if (v) return `${cur}${v}${unit}`;
  if (lo) return `${cur}${lo}+${unit}`;
  if (hi) return `${cur}${hi}${unit}`;
  return "";
}

// Best-effort: does this location string / country list look United States?
// Returns ["united states"] for US, ["__foreign__"] for a clearly non-US place,
// or [] when unknown. The runner's allow-list only contains "united states", so
// "__foreign__" and [] are rejected for non-remote roles (matches career-site).
function usCountriesFromText(...parts) {
  const s = parts.filter(Boolean).join(" ").toLowerCase();
  if (!s.trim()) return [];
  if (US_SIGNALS.some((x) => s.includes(x))) return ["united states"];
  const m = s.match(/,\s*([a-z]{2})\b/);
  if (m && US_STATE_ABBR.has(m[1])) return ["united states"];
  if (FOREIGN_SIGNALS.some((x) => s.includes(x))) return ["__foreign__"];
  return [];
}

function isRemoteText(...parts) {
  return /\bremote\b/i.test(parts.filter(Boolean).join(" "));
}

function arrangementLabel({ remote, hybrid, raw } = {}) {
  if (raw) {
    if (/hybrid/i.test(raw)) return "Hybrid";
    if (/remote/i.test(raw)) return "Remote";
    if (/on.?site|in.?office/i.test(raw)) return "On-site";
  }
  if (hybrid) return "Hybrid";
  if (remote) return "Remote";
  return "";
}

function toDate(v) {
  if (v == null || v === "") return "";
  // Epoch seconds or milliseconds.
  if (typeof v === "number" || /^\d{10,13}$/.test(String(v))) {
    let n = Number(v);
    if (n < 1e12) n *= 1000; // seconds -> ms
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  }
  const s = String(v);
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  if (m) return m[0];
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return "";
}

// LinkedIn's actor returns a relative posted string ("12 hours ago", "1 day
// ago"). Convert it to an ISO date, anchored on scrapedAt (or now).
function relPostedToDate(s, scrapedAt) {
  const t = String(s || "").toLowerCase().trim();
  const now = scrapedAt ? new Date(scrapedAt) : new Date();
  if (!t) return scrapedAt ? toDate(scrapedAt) : "";
  const iso = (d) => d.toISOString().slice(0, 10);
  let m;
  if (/just now|just posted|minute|hour|today/.test(t)) return iso(now);
  if ((m = t.match(/(\d+)\s*day/))) {
    const d = new Date(now);
    d.setDate(d.getDate() - Number(m[1]));
    return iso(d);
  }
  if ((m = t.match(/(\d+)\s*week/))) {
    const d = new Date(now);
    d.setDate(d.getDate() - Number(m[1]) * 7);
    return iso(d);
  }
  if ((m = t.match(/(\d+)\s*month/))) {
    const d = new Date(now);
    d.setMonth(d.getMonth() - Number(m[1]));
    return iso(d);
  }
  return toDate(s) || (scrapedAt ? toDate(scrapedAt) : "");
}

function wellfoundSizeLabel(code) {
  const m = String(code || "").match(/SIZE_(\d+)_(\d+)/);
  if (m) return `${m[1]}-${m[2]}`;
  if (/SIZE_.*PLUS|10000/i.test(code || "")) return "10000+";
  return String(code || "").replace(/^SIZE_/, "").replace(/_/g, "-");
}

// ---- per-source adapters ---------------------------------------------------

// fantastic-jobs career-site actor (existing schema).
function mapCareerSite(job) {
  if (!job || job.id == null) return null;
  const remote = isRemoteText(job.ai_work_arrangement);
  const remoteLocations = (job.ai_remote_location_derived || job.ai_remote_location || []).map((c) =>
    String(c).toLowerCase()
  );
  const location = remote
    ? remoteLocations.length
      ? `Remote (${job.ai_remote_location_derived?.[0] || job.ai_remote_location?.[0]})`
      : "Remote"
    : job.locations_derived?.[0] || job.cities_derived?.[0] || job.countries_derived?.[0] || "n/a";
  return {
    id: `career-${job.id}`,
    title: job.title || "(untitled)",
    company: job.organization || job.org_linkedin_name || "(unknown)",
    url: job.url || "",
    posted: toDate(job.date_posted || job.date_created),
    location,
    arrangement: arrangementLabel({ remote, raw: job.ai_work_arrangement }),
    exp: job.ai_experience_level || "",
    salary: salaryLabel({
      min: job.ai_salary_min_value,
      max: job.ai_salary_max_value,
      value: job.ai_salary_value,
      currency: job.ai_salary_currency,
      interval: job.ai_salary_unit_text,
    }),
    size: job.org_linkedin_size || "",
    source: job.source || job.domain_derived || "career-site",
    description: stripToText(
      `${job.ai_requirements_summary || ""}\n${job.description_text || ""}`
    ),
    skills: [...(job.ai_key_skills || []), ...(job.ai_keywords || [])],
    countries: (job.countries_derived || []).map((c) => String(c).toLowerCase()),
    remote,
    remoteLocations,
    _visaField: job.ai_visa_sponsorship,
  };
}

// openclawai/job-board-scraper (JobSpy). One row per board listing.
function mapJobSpy(item) {
  if (!item || (item.id == null && !item.job_url)) return null;
  const loc = item.location || "";
  const remote = item.is_remote === true || isRemoteText(loc, item.title);
  const countries = usCountriesFromText(loc);
  return {
    id: `jobspy-${item.site || "x"}-${item.id || item.job_url}`,
    title: item.title || "(untitled)",
    company: item.company || "(unknown)",
    url: item.job_url_direct || item.job_url || "",
    posted: toDate(item.date_posted),
    location: loc || (remote ? "Remote" : "n/a"),
    arrangement: arrangementLabel({ remote }),
    exp: "",
    salary: salaryLabel({
      min: item.salary_min,
      max: item.salary_max,
      currency: item.salary_currency,
      interval: item.salary_interval,
    }),
    size: item.company_num_employees || "",
    source: item.site || "jobspy",
    description: stripToText(item.description),
    skills: [],
    countries,
    remote,
    remoteLocations: remote ? countries : [],
  };
}

// blackfalcondata/dice-com-job-scraper.
function mapDice(item) {
  if (!item || (!item.jobId && !item.title)) return null;
  const loc = item.location || "";
  const workplace = Array.isArray(item.workplaceTypes)
    ? item.workplaceTypes.join(" ")
    : item.workplaceTypes || "";
  const remote = /remote/i.test(workplace) || isRemoteText(loc);
  const countries = usCountriesFromText(loc, item.applicantLocationRequirements, item.sourceCountry);
  return {
    id: `dice-${item.jobId || item.jobKey}`,
    title: item.title || "(untitled)",
    company: item.company || "(unknown)",
    url: item.applyUrl || item.canonicalUrl || item.sourceUrl || "",
    posted: toDate(item.postedDate),
    location: loc || (remote ? "Remote" : "n/a"),
    arrangement: arrangementLabel({ remote, raw: workplace }),
    exp: "",
    salary: salaryLabel({
      min: item.salaryMin,
      max: item.salaryMax,
      currency: item.salaryCurrency,
      interval: item.salaryType,
    }),
    size: item.companyEmployeeRange || "",
    source: "dice",
    description: stripToText(item.description || item.descriptionMarkdown),
    skills: Array.isArray(item.skills) ? item.skills : [],
    countries: countries.length ? countries : ["united states"],
    remote,
    remoteLocations: remote ? (countries.length ? countries : ["united states"]) : [],
  };
}

// misceres/indeed-scraper (Indeed, ~2M runs, reliable). Replaces JobSpy's slow/
// aborting Indeed+Google leg. postingDateParsed is ISO; externalApplyLink is the
// direct ATS apply URL; isExpired lets us skip dead listings.
function mapIndeed(item) {
  if (!item || (!item.id && !item.url)) return null;
  if (item.isExpired === true) return null;
  const loc = item.location || "";
  const remote = isRemoteText(loc, item.positionName);
  const countries = usCountriesFromText(loc);
  return {
    id: `indeed-${item.id || item.url}`,
    title: item.positionName || "(untitled)",
    company: item.company || "(unknown)",
    url: item.externalApplyLink || item.url || "",
    posted: toDate(item.postingDateParsed || item.postedAt || item.scrapedAt),
    location: loc || (remote ? "Remote" : "n/a"),
    arrangement: arrangementLabel({ remote }),
    exp: "",
    salary: typeof item.salary === "string" && /\d/.test(item.salary) ? item.salary : "",
    size: "",
    source: "indeed",
    description: stripToText(item.description || item.descriptionHTML),
    skills: [],
    countries: countries.length ? countries : ["united states"],
    remote,
    remoteLocations: remote ? (countries.length ? countries : ["united states"]) : [],
  };
}

// parsebird/handshake-jobs-scraper (public listings).
function mapHandshake(item) {
  if (!item || (!item.job_id && !item.job_title)) return null;
  const loc = item.location || "";
  const remote = item.is_remote === true || isRemoteText(loc);
  const countries = usCountriesFromText(loc);
  return {
    id: `handshake-${item.job_id || item.URL}`,
    title: item.job_title || "(untitled)",
    company: item.company_name || "(unknown)",
    url: item.URL || item.employer_website || "",
    posted: toDate(item.date || item.posted_at),
    location: loc || (remote ? "Remote" : "n/a"),
    arrangement: arrangementLabel({ remote }),
    exp: "",
    salary: salaryLabel({
      min: item.salary_min,
      max: item.salary_max,
      currency: item.salary_currency,
      interval: item.salary_period,
    }),
    size: "",
    source: "handshake",
    description: stripToText(item.description),
    skills: [],
    countries,
    remote,
    remoteLocations: remote ? countries : [],
  };
}

// clearpath/wellfound-api-ppe (startups).
function mapWellfound(item) {
  if (!item || (item.id == null && !item.title)) return null;
  const locNames = Array.isArray(item.location_names) ? item.location_names : [];
  const remote = item.remote === true || isRemoteText(locNames.join(" "));
  const countries = usCountriesFromText(locNames.join(" "));
  const base = item.base_salary || item.compensation_parsed?.base_salary || {};
  const exp =
    item.years_experience_min != null || item.years_experience_max != null
      ? `${item.years_experience_min ?? 0}-${item.years_experience_max ?? ""}yr`.replace(/-$/, "+")
      : "";
  return {
    id: `wellfound-${item.id || item.slug}`,
    title: item.title || "(untitled)",
    company: item.company_name || "(unknown)",
    url: item.url || item.source_url || "",
    posted: toDate(item.live_start_at_readable || item.live_start_at || item.scraped_at_timestamp),
    location: locNames.join(", ") || (remote ? "Remote" : "n/a"),
    arrangement: arrangementLabel({ remote }),
    exp,
    salary:
      salaryLabel({
        min: base.min_value,
        max: base.max_value,
        currency: base.currency,
        interval: base.unit,
      }) || (item.compensation || ""),
    size: wellfoundSizeLabel(item.company_size),
    source: "wellfound",
    description: stripToText(item.description || item.description_snippet),
    skills: [],
    countries: countries.length ? countries : remote ? [] : ["united states"],
    remote,
    remoteLocations: remote ? countries : [],
  };
}

// sourabhbgp/linkedin-jobs-scraper (dedicated LinkedIn jobs, account-safe).
// Replaces JobSpy's broken LinkedIn module (which returned zero LinkedIn rows).
// enrichDetails=true gives a full description for scoring/sponsorship/language.
function mapLinkedIn(item) {
  if (!item || (item.jobId == null && !item.jobUrl)) return null;
  // location comes as "Warren, MI\n   128 applicants" — take the first line and
  // strip any trailing applicant count.
  const locRaw = String(item.location || "")
    .split(/\n/)[0]
    .replace(/\d[\d,]*\s+applicants?.*$/i, "")
    .trim();
  const remote = isRemoteText(item.location, item.title, item.employmentType);
  const countries = usCountriesFromText(locRaw);
  // Applicant count ("128 applicants" / "Over 100 applicants") is a proxy for a
  // stale/oversubscribed listing (the actor exposes no repost flag). Parse it
  // from applicantCount or the trailing count baked into the location string.
  const applicantsRaw = String(item.applicantCount || item.location || "");
  const overHundred = /over\s+100/i.test(applicantsRaw);
  const am = applicantsRaw.match(/(\d[\d,]*)\s+applicants?/i);
  const applicants = overHundred ? 101 : am ? Number(am[1].replace(/,/g, "")) : null;
  const repost = /\brepost/i.test(String(item.postedDate || ""));
  return {
    id: `linkedin-${item.jobId || item.jobUrl}`,
    title: item.title || "(untitled)",
    company: item.company || "(unknown)",
    url: item.applyUrl || item.jobUrl || "",
    posted: relPostedToDate(item.postedDate, item.scrapedAt),
    location: locRaw || (remote ? "Remote" : "n/a"),
    arrangement: arrangementLabel({ remote }),
    exp: item.seniorityLevel || "",
    salary: typeof item.salary === "string" && /\d/.test(item.salary) ? item.salary : "",
    size: "",
    source: "linkedin",
    description: stripToText(item.description),
    skills: [],
    countries: countries.length ? countries : remote ? [] : ["united states"],
    remote,
    remoteLocations: remote ? countries : [],
    applicants: Number.isFinite(applicants) ? applicants : null,
    repost,
  };
}

// jobscrawler/jobright-scraper. NOTE: returns placeholder/mock rows as of
// 2026-08-21 (company "InnovateTech", templated descriptions). Adapter kept for
// when a reliable actor appears; the source is disabled by default in config.
function mapJobRight(item, idx = 0) {
  if (!item || !item.jobTitle) return null;
  const loc = item.location || "";
  const remote = isRemoteText(loc, item.jobType);
  const countries = usCountriesFromText(loc, item.country);
  return {
    id: `jobright-${item.applyUrl || idx}`,
    title: item.jobTitle || "(untitled)",
    company: item.companyName || "(unknown)",
    url: item.applyUrl || item.companyUrl || "",
    posted: toDate(item.postedDate),
    location: loc || (remote ? "Remote" : "n/a"),
    arrangement: arrangementLabel({ remote }),
    exp: item.experienceLevel || "",
    salary: typeof item.salary === "string" && /\d/.test(item.salary) ? item.salary : "",
    size: "",
    source: "jobright",
    description: stripToText(
      `${item.description || ""}\n${(item.requirements || []).join(", ")}`
    ),
    skills: Array.isArray(item.requirements) ? item.requirements : [],
    countries: countries.length ? countries : ["united states"],
    remote,
    remoteLocations: remote ? (countries.length ? countries : ["united states"]) : [],
  };
}

// ---- input builders --------------------------------------------------------

function careerInput(cfg, ctx) {
  const q = cfg.query || {};
  return {
    timeRange: ctx.timeRange,
    limit: ctx.limit,
    descriptionType: "text",
    includeCompanyDetails: true,
    titleSearch: q.titleSearch,
    titleExclusionSearch: q.titleExclusionSearch,
    aiExperienceLevelFilter: q.experienceLevels,
    aiEmploymentTypeFilter: q.employmentTypes,
    aiTaxonomiesFilter: q.taxonomies,
  };
}

function aggregatorTerms(cfg, sc, fallbackCount) {
  const terms = sc.terms || cfg.aggregatorSearchTerms || ["software engineer"];
  return fallbackCount ? terms.slice(0, fallbackCount) : terms;
}

function jobSpyInputs(cfg, sc, ctx) {
  return [
    {
      // openclawai/job-board-scraper caps searchTerms at 5.
      searchTerms: aggregatorTerms(cfg, sc).slice(0, 5),
      location: sc.location || cfg.aggregatorLocation || "United States",
      sites: sc.sites || ["linkedin", "indeed", "glassdoor", "zip_recruiter", "google"],
      maxResults: sc.maxResults ?? 40,
      hoursOld: sc.hoursOld ?? ctx.hoursOld ?? 24,
      countryIndeed: sc.countryIndeed || "usa",
      descriptionFormat: "markdown",
      linkedinFetchDescription: sc.linkedinFetchDescription ?? true,
      ...(sc.proxy ? { proxyConfiguration: sc.proxy } : {}),
    },
  ];
}

function diceInputs(cfg, sc, ctx) {
  // Dice takes a single `query` per run — cap the number of terms for cost.
  const terms = aggregatorTerms(cfg, sc, sc.termCount ?? 3);
  return terms.map((query) => ({
    query,
    location: sc.location || cfg.aggregatorLocation || "United States",
    postedDate: sc.postedDate || "THREE",
    maxResults: sc.maxResults ?? 30,
    maxPages: sc.maxPages ?? 2,
    includeDetails: true,
    descriptionFormat: "text",
  }));
}

function indeedInputs(cfg, sc) {
  return aggregatorTerms(cfg, sc).map((position) => ({
    position,
    location: sc.location || cfg.aggregatorLocation || "United States",
    country: sc.country || "US",
    maxItemsPerSearch: sc.maxResults ?? 30,
    parseCompanyDetails: false,
    saveOnlyUniqueItems: true,
    followApplyRedirects: false,
  }));
}

function handshakeInputs(cfg, sc) {
  // includeKeyword accepts comma-separated phrases → one run covers all terms.
  return [
    {
      includeKeyword: aggregatorTerms(cfg, sc).join(", "),
      locationName: sc.location || cfg.aggregatorLocation || "United States",
      countryName: sc.countryName || "United States",
      jobType: sc.jobType || "FULLTIME",
      datePosted: sc.datePosted || "3days",
      pagesToFetch: sc.pagesToFetch ?? 2,
      ...(sc.proxy ? { proxyConfiguration: sc.proxy } : {}),
    },
  ];
}

function wellfoundInputs(cfg, sc) {
  const urls = sc.roleUrls || ["https://wellfound.com/role/software-engineer"];
  return [
    {
      urls,
      pageLimit: sc.pageLimit ?? 1,
      onlyRemoteJobs: sc.onlyRemoteJobs ?? false,
      sortBy: "LAST_POSTED",
    },
  ];
}

function linkedinInputs(cfg, sc) {
  const terms = aggregatorTerms(cfg, sc);
  // LinkedIn's AI search ignores the experienceLevel filter (verified 2026-08-22:
  // experienceLevel="entry" still returned "Senior Software Engineer"), so we run
  // one pass per term ("any") and let the post-fetch title/years filters do the
  // real work. experienceLevels stays configurable if that ever changes.
  const levels = sc.experienceLevels && sc.experienceLevels.length ? sc.experienceLevels : ["any"];
  const inputs = [];
  for (const keywords of terms) {
    for (const experienceLevel of levels) {
      inputs.push({
        mode: "search",
        keywords,
        location: sc.location || cfg.aggregatorLocation || "United States",
        maxResults: sc.maxResults ?? 50,
        datePosted: sc.datePosted || "past24h",
        experienceLevel,
        workplaceType: sc.workplaceType || "any",
        sortBy: sc.sortBy || "recent",
        enrichDetails: sc.enrichDetails ?? true,
      });
    }
  }
  return inputs;
}

function jobRightInputs(cfg, sc) {
  const terms = aggregatorTerms(cfg, sc, sc.termCount ?? 2);
  return terms.map((keyword) => ({
    keyword,
    location: sc.location || cfg.aggregatorLocation || "United States",
    country: "US",
    maxItems: sc.maxItems ?? 25,
    datePosted: sc.datePosted || "3d",
    includeCompanyDetails: true,
    includeSalary: true,
  }));
}

// ---- registry --------------------------------------------------------------

// priority: lower wins when the same role appears on multiple boards (used to
// choose the representative row in cross-source dedup).
export const SOURCE_REGISTRY = {
  career: {
    id: "career",
    label: "career-site",
    kind: "career",
    priority: 1,
    defaultActor: "fantastic-jobs/career-site-job-listing-api",
    buildInputs: (cfg, ctx) => [careerInput(cfg, ctx)],
    map: (item) => mapCareerSite(item),
  },
  linkedin: {
    id: "linkedin",
    label: "linkedin",
    kind: "aggregator",
    priority: 2,
    defaultActor: "sourabhbgp/linkedin-jobs-scraper",
    buildInputs: (cfg, ctx, sc) => linkedinInputs(cfg, sc),
    map: (item) => mapLinkedIn(item),
  },
  dice: {
    id: "dice",
    label: "dice",
    kind: "aggregator",
    priority: 3,
    defaultActor: "blackfalcondata/dice-com-job-scraper",
    buildInputs: (cfg, ctx, sc) => diceInputs(cfg, sc, ctx),
    map: (item) => mapDice(item),
  },
  wellfound: {
    id: "wellfound",
    label: "wellfound",
    kind: "aggregator",
    priority: 4,
    defaultActor: "clearpath/wellfound-api-ppe",
    buildInputs: (cfg, ctx, sc) => wellfoundInputs(cfg, sc),
    map: (item) => mapWellfound(item),
  },
  indeed: {
    id: "indeed",
    label: "indeed",
    kind: "aggregator",
    priority: 5,
    defaultActor: "misceres/indeed-scraper",
    buildInputs: (cfg, ctx, sc) => indeedInputs(cfg, sc),
    map: (item) => mapIndeed(item),
  },
  jobspy: {
    id: "jobspy",
    label: "jobspy",
    kind: "aggregator",
    priority: 6,
    defaultActor: "openclawai/job-board-scraper",
    buildInputs: (cfg, ctx, sc) => jobSpyInputs(cfg, sc, ctx),
    map: (item) => mapJobSpy(item),
  },
  handshake: {
    id: "handshake",
    label: "handshake",
    kind: "aggregator",
    priority: 6,
    defaultActor: "parsebird/handshake-jobs-scraper",
    buildInputs: (cfg, ctx, sc) => handshakeInputs(cfg, sc),
    map: (item) => mapHandshake(item),
  },
  jobright: {
    id: "jobright",
    label: "jobright",
    kind: "aggregator",
    priority: 7,
    defaultActor: "jobscrawler/jobright-scraper",
    buildInputs: (cfg, ctx, sc) => jobRightInputs(cfg, sc),
    map: (item, idx) => mapJobRight(item, idx),
  },
};

// Canonical key for cross-source dedup: same company + role + city collapse to
// one, regardless of which board surfaced it.
export function canonicalKey(n) {
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  const company = norm(n.company);
  const title = norm(n.title)
    .replace(/\b(senior|sr|junior|jr|staff|principal|lead|associate|i{1,3}|iv|v)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const city = norm((n.location || "").split(/[,(]/)[0]) || (n.remote ? "remote" : "");
  return `${company}::${title}::${city}`;
}

export { salaryLabel, usCountriesFromText, stripToText };
