#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }

    args[key] = next;
    index += 1;
  }
  return args;
}

function requireArg(args, key) {
  if (!args[key]) {
    throw new Error(`Missing required argument --${key}`);
  }
  return args[key];
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function buildContactSection(contact, index) {
  return [
    `## Contact ${index + 1}`,
    "",
    `- \`name\`: ${contact.name ?? ""}`,
    `- \`title\`: ${contact.title ?? ""}`,
    `- \`email\`: ${contact.email ?? ""}`,
    `- \`email_source\`: ${contact.email_source ?? ""}`,
    `- \`email_status\`: ${contact.email_status ?? ""}`,
    `- \`location\`: ${contact.location ?? ""}`,
    `- \`alumni_status\`: ${contact.alumni_status ?? ""}`,
    `- \`lane\`: ${contact.lane ?? ""}`,
    `- \`follow_up_plan\`: ${contact.follow_up_plan ?? ""}`,
    `- \`contact_type\`: ${contact.contact_type ?? ""}`,
    `- \`source_links\`: ${Array.isArray(contact.source_links) ? contact.source_links.join(", ") : contact.source_links ?? ""}`,
    `- \`linkedin_profile\`: ${contact.linkedin_profile ?? ""}`,
    `- \`linkedin_active_signal\`: ${contact.linkedin_active_signal ?? ""}`,
    `- \`linkedin_note_under_300\`: ${contact.linkedin_note_under_300 ?? ""}`,
    "- `why_relevant`: ",
    "- `trigger`: ",
    "- `proof_id`: ",
    "- `best_proof`: ",
    "- `proof_type`: ",
    "- `pull_line`: ",
    "- `cta`: ",
    "- `confidence`: ",
    "- `subject_idea`: ",
    "- `notes`: ",
    "",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const company = requireArg(args, "company");
  const role = requireArg(args, "role");
  const contacts = args["contacts-json"] ? JSON.parse(args["contacts-json"]) : [];

  const today = new Date().toISOString().slice(0, 10);
  const defaultOutput = path.join(
    process.cwd(),
    "output",
    "contact-briefs",
    `${slugify(company)}-${slugify(role)}-${today}.md`
  );
  const outputPath = args.output ?? defaultOutput;

  const content = [
    "# Contact Research Brief",
    "",
    "Use this before writing a cold-outreach batch.",
    "",
    "## Batch",
    "",
    `- \`company\`: ${company}`,
    `- \`role\`: ${role}`,
    `- \`job_link\`: ${args["job-link"] ?? ""}`,
    "- `core role themes`: ",
    "- `best 3 proof snippets from my background`: ",
    "- `recommended proof ids from proof bank`: ",
    "- `core_contact_strategy`: ",
    "- `optional_alumni_support_strategy`: ",
    "- `alumni_filter_stack_used`: ",
    "- `title_sets_used`: ",
    "- `target_person_locations`: ",
    "- `target_organization_locations`: ",
    "",
    "## Confidence Guide",
    "",
    "- `A`: direct public evidence tied to this person or team",
    "- `B`: strong inference from title, org, location, and role scope",
    "- `C`: weak inference only",
    "",
    "Rule:",
    "",
    "- do not draft from `C` unless there is no better contact and the email stays very simple",
    "",
    "## Email Rule",
    "",
    "- use exact Apollo work emails only for the email lane",
    "- if Apollo does not give the exact address, leave `email` blank",
    "- use `email_source` and `email_status` so the lane is auditable",
    "- route non-Apollo contacts into LinkedIn-only lanes when appropriate",
    "",
    ...(contacts.length > 0
      ? contacts.flatMap((contact, index) => [buildContactSection(contact, index)])
      : [
          buildContactSection({}, 0),
          buildContactSection({}, 1),
          buildContactSection({}, 2),
          buildContactSection({}, 3),
          buildContactSection({}, 4),
        ]),
    "## Batch Checks",
    "",
    "1. Do at least 3 contacts have person-specific triggers?",
    "2. Do at least 3 contacts use different proof lines?",
    "3. Are there at least 2 different CTA shapes across the batch?",
    "4. Are all contacts confirmed US-based for US roles?",
    "5. Does each contact have `A` or `B` confidence, or a clear reason for remaining `C`?",
    "6. For any LinkedIn note included, is there a real activity signal and is the note under `300` characters?",
    "7. Is every queued email address an exact Apollo work email?",
    "8. Does every queued email have a concrete metric or verifiable artifact in `best_proof`?",
    "9. Does the copy avoid generic hedge phrases like `directionally relevant` and `my background is strongest in`?",
    "",
  ].join("\n");

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, content, "utf8");

  console.log(
    JSON.stringify(
      {
        outputPath,
        company,
        role,
        contactCount: contacts.length || 5,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
