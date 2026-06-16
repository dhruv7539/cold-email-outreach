import fs from 'fs';
const cfg = JSON.parse(fs.readFileSync(process.env.HOME + '/.cursor/mcp.json', 'utf8'));
const apiKey = cfg.mcpServers.apollo.env.APOLLO_API_KEY;
const baseUrl = cfg.mcpServers.apollo.env.APOLLO_BASE_URL;

const body = {
  person_titles: ['Software Engineer', 'Senior Software Engineer', 'Staff Software Engineer', 'Software Engineer II'],
  organization_ids: ['5c2392d8f651256b12906aff'],
  // Captured from Apollo web UI search breadcrumbs/network payload.
  // USC school filter must use the school id Apollo expects, not a free-text name.
  person_education_school_ids: ['54a1218e69702d9d7e6c7302'],
  per_page: 15,
  page: 1
};

const res = await fetch(baseUrl + '/mixed_people/api_search', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
  body: JSON.stringify(body)
});
const json = await res.json();
console.log(JSON.stringify((json.people || []).map(p => ({
  id: p.id,
  first_name: p.first_name,
  last_name_obfuscated: p.last_name_obfuscated,
  title: p.title,
  company: p.organization?.name,
  has_email: p.has_email,
  has_city: p.has_city,
  has_state: p.has_state,
  has_direct_phone: p.has_direct_phone
})), null, 2));
