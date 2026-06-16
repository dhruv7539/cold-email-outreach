/**
 * Example email spec file.
 *
 * Copy this format when authoring a new campaign. Each draft becomes one row
 * in the Google Sheet queue with a main email + up to 2 follow-ups.
 *
 * Replace YOUR_FIRST_NAME and example.com contacts before importing.
 */

export default {
  drafts: [
    {
      key: "jane-doe",
      lane: "cold",
      contactName: "Jane Doe",
      firstName: "Jane",
      contactType: "recruiter",
      to: "jane.doe@example.com",
      subject: "Example Corp new grad SWE — quick question",
      html: [
        "<p>Hi Jane,</p>",
        "<p>I applied to the Software Engineer role (req 12345) and wanted to check if my profile is landing in the right pipeline. I'm finishing my MS in CS at My University in May 2026.</p>",
        "<p>At My Previous Company, I optimized a Django + PostgreSQL backend on AWS, improving API throughput 42% and reducing p95 latency 35% under peak load. Would it make sense to stay with this req, or should I look at a nearby team?</p>",
        "<p>Thanks,<br>YOUR_FIRST_NAME</p>",
      ].join("\n"),
      followUp1Html: [
        "<p>Hi Jane,</p>",
        "<p>Following up on my earlier note — still very interested in the SWE role. Happy to share more detail on my backend + systems experience if helpful.</p>",
        "<p>Thanks,<br>YOUR_FIRST_NAME</p>",
      ].join("\n"),
      followUp2Html: [
        "<p>Hi Jane,</p>",
        "<p>One last follow-up. If there's a better person or team to reach out to, I'd appreciate the pointer.</p>",
        "<p>Thanks,<br>YOUR_FIRST_NAME</p>",
      ].join("\n"),
      notes: "Example spec — replace with real Apollo enrich data before import",
    },
    {
      key: "john-smith",
      lane: "cold",
      contactName: "John Smith",
      firstName: "John",
      contactType: "hiring_manager",
      to: "john.smith@example.com",
      subject: "Quick question about Example Corp platform team",
      html: [
        "<p>Hi John,</p>",
        "<p>I saw that you lead the platform engineering team at Example Corp. I'm finishing my MS in CS at My University in May 2026 and am exploring the SWE role (req 12345).</p>",
        "<p>I built a distributed file system with Raft consensus, benchmarked at 47K+ ops/sec with 64 concurrent clients. Does this kind of systems background align with what your team is looking for?</p>",
        "<p>Thanks,<br>YOUR_FIRST_NAME</p>",
      ].join("\n"),
      followUp1Html: [
        "<p>Hi John,</p>",
        "<p>Wanted to follow up — I'm particularly interested in the infrastructure work your team does. Happy to share my GitHub or a project summary if that would be useful.</p>",
        "<p>Thanks,<br>YOUR_FIRST_NAME</p>",
      ].join("\n"),
      followUp2Html: [
        "<p>Hi John,</p>",
        "<p>Last note from me. If there's a better team or person to connect with, I'd really appreciate the pointer.</p>",
        "<p>Thanks,<br>YOUR_FIRST_NAME</p>",
      ].join("\n"),
      notes: "Example spec — replace with real Apollo enrich data before import",
    },
  ],
};
