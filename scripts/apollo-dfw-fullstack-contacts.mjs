#!/usr/bin/env node
/**
 * Search Apollo for contacts (verified email), then enrich to return work emails.
 * Reads APOLLO_API_KEY and APOLLO_BASE_URL from ~/.cursor/mcp.json (mcpServers.apollo.env).
 *
 * Usage:
 *   node scripts/apollo-dfw-fullstack-contacts.mjs
 *   node scripts/apollo-dfw-fullstack-contacts.mjs --geo carrollton
 *   node scripts/apollo-dfw-fullstack-contacts.mjs --organization-ids id1,id2
 */

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function loadApolloConfig() {
  const mcpPath = path.join(process.env.HOME || "", ".cursor", "mcp.json");
  const cfg = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  const env = cfg.mcpServers?.apollo?.env;
  if (!env?.APOLLO_API_KEY || !env?.APOLLO_BASE_URL) {
    throw new Error("Missing apollo env in ~/.cursor/mcp.json (mcpServers.apollo.env)");
  }
  return { apiKey: env.APOLLO_API_KEY, baseUrl: env.APOLLO_BASE_URL.replace(/\/$/, "") };
}

async function apiSearch(body) {
  const { apiKey, baseUrl } = loadApolloConfig();
  const res = await fetch(`${baseUrl}/mixed_people/api_search`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`api_search ${res.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

async function peopleMatch(personId) {
  const { apiKey, baseUrl } = loadApolloConfig();
  const url = new URL(`${baseUrl}/people/match`);
  url.searchParams.set("id", personId);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`people/match ${res.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

const DFW_ORG_LOCATIONS = [
  "Carrollton, Texas",
  "Dallas, Texas",
  "Irving, Texas",
  "Plano, Texas",
  "Frisco, Texas",
  "Farmers Branch, Texas",
];

const CARROLLTON_ORG_LOCATIONS = ["Carrollton, Texas"];

const SEARCHES = [
  {
    key: "recruiter",
    person_titles: ["Technical Recruiter", "Talent Acquisition", "Recruiter", "Senior Recruiter"],
    person_seniorities: ["manager", "senior"],
  },
  {
    key: "eng-manager-legacy",
    person_titles: ["Engineering Manager", "Software Engineering Manager"],
    person_seniorities: ["manager"],
  },
  {
    key: "lead-fullstack",
    person_titles: [
      "Staff Software Engineer",
      "Principal Software Engineer",
      "Lead Software Engineer",
      "Senior Software Engineer",
      "Full Stack Developer",
    ],
    person_seniorities: ["senior"],
  },
  {
    key: "mobile-apps-lead",
    person_titles: [
      "Mobile Engineering Manager",
      "Senior Mobile Engineer",
      "Software Engineer Mobile",
      "iOS Developer",
      "Android Developer",
    ],
    person_seniorities: ["manager", "senior"],
  },
  {
    key: "director-engineering",
    person_titles: [
      "VP Engineering",
      "Vice President Engineering",
      "Director of Engineering",
      "Head of Engineering",
      "VP of Engineering",
    ],
    person_seniorities: ["vp", "director", "head"],
  },
];

function firstPersonEmail(person) {
  const email =
    person?.email ||
    person?.contact_emails?.[0]?.email ||
    person?.organization?.primary_domain;
  return typeof email === "string" && email.includes("@") ? email : "";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const geo = String(args.geo || "dfw").toLowerCase();
  let organizationLocations = DFW_ORG_LOCATIONS;
  if (geo === "carrollton") {
    organizationLocations = CARROLLTON_ORG_LOCATIONS;
  }

  const orgIdsArg = args["organization-ids"];
  const organizationIds = orgIdsArg
    ? orgIdsArg.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const picked = [];
  const seenIds = new Set();

  for (const spec of SEARCHES) {
    const body = {
      organization_locations: organizationLocations,
      person_titles: spec.person_titles,
      person_seniorities: spec.person_seniorities,
      contact_email_status: ["verified"],
      include_similar_titles: true,
      per_page: 15,
      page: 1,
    };
    if (organizationIds.length > 0) {
      body.organization_ids = organizationIds;
    }

    let json;
    try {
      json = await apiSearch(body);
    } catch (e) {
      console.error(JSON.stringify({ lane: spec.key, search_error: String(e.message) }));
      continue;
    }

    const people = json.people || json.contacts || [];
    const candidate = people.find((p) => p.id && !seenIds.has(p.id));
    if (!candidate) {
      console.error(
        JSON.stringify({
          lane: spec.key,
          note: "no_candidates",
          total_entries: json.pagination?.total_entries,
        })
      );
      continue;
    }

    seenIds.add(candidate.id);

    let enriched;
    try {
      enriched = await peopleMatch(candidate.id);
    } catch (e) {
      console.error(JSON.stringify({ lane: spec.key, person_id: candidate.id, enrich_error: String(e.message) }));
      continue;
    }

    const person = enriched.person || enriched;
    const email = firstPersonEmail(person);
    const org = person.organization?.name || candidate.organization?.name || "";

    picked.push({
      lane: spec.key,
      person_id: candidate.id,
      first_name: person.first_name || candidate.first_name || "",
      last_name: person.last_name || candidate.last_name || "",
      name: [person.first_name || candidate.first_name, person.last_name || candidate.last_name].filter(Boolean).join(" "),
      title: person.title || candidate.title || "",
      organization: org,
      email,
      email_status: person.email_status || person.email_true_status || "",
      linkedin_url: person.linkedin_url || candidate.linkedin_url || "",
    });
  }

  const out = {
    geo,
    organization_locations: organizationLocations,
    organization_ids: organizationIds,
    count: picked.length,
    contacts: picked,
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
