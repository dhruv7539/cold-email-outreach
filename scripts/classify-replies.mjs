#!/usr/bin/env node
// Reply classifier for the outreach Queue.
//
// Scans the Queue sheet for rows that Apps Script has marked as `replied`
// but which we have not yet classified, pulls the latest inbound message in
// each thread via Gmail API, classifies it with a rule-based classifier,
// and appends the result to the `Replies` sheet so we get a triage view:
//
//   queue_row | classified_at | company | contact_name | recipient_email
//     | subject | classification | confidence | snippet | received_at
//     | needs_action | actioned | note
//
// At the end it prints a quick summary (e.g. "3 positive replies waiting on
// your response") so you can run this on a cron and see what needs your
// attention without opening the sheet.
//
// Rule-based classifier categories:
//   positive      — person engaged, wants to continue the conversation
//   referral      — redirects you to someone else on the team
//   confused      — replied but can't tell what you're asking ("not sure what
//                   you're asking") — RECOVERABLE: send the recovery template
//                   (COLD_EMAIL_PLAYBOOK.md "Reply handling") within 24h
//   not_interested — closed door (no openings, not a fit, filled)
//   auto_reply    — out-of-office / vacation responder
//   unclear       — default when no strong signal matches (flag for manual)
//
// Usage:
//   node scripts/classify-replies.mjs                 # classify + summary
//   node scripts/classify-replies.mjs --summary-only  # skip classification, just show current stats
//   node scripts/classify-replies.mjs --dry-run       # don't append to sheet
//   node scripts/classify-replies.mjs --limit 5       # cap number of threads processed
//   node scripts/classify-replies.mjs --llm           # use Anthropic API (needs
//                                                       ANTHROPIC_API_KEY) with
//                                                       rule-based fallback

import {
  getOutreachSpreadsheetId,
  OUTREACH_QUEUE_HEADERS,
  OUTREACH_SHEET_NAMES,
} from "./config.mjs";
import {
  getAccessToken,
  getDefaultOauthPaths,
  getThread,
  getHeader,
} from "./gmail-api.mjs";
import {
  getSheetsAccessToken,
  getSheetValues,
  appendSheetValues,
} from "./sheets-api.mjs";

export const REPLIES_SHEET_NAME = "Replies";

export const REPLIES_HEADERS = [
  "queue_row",
  "classified_at",
  "company",
  "contact_name",
  "recipient_email",
  "subject",
  "classification",
  "confidence",
  "snippet",
  "received_at",
  "needs_action",
  "actioned",
  "note",
];

// ---------- Classifier ----------

// Keyword-based heuristic rules. Ordered roughly by specificity; we score
// every category against the message and return the highest-scoring one.
// Keys are the lowercased message body; `weight` is how strong the signal is.
const CLASSIFIER_RULES = {
  auto_reply: [
    { pattern: /\b(out of office|out-of-office)\b/, weight: 3 },
    { pattern: /\bon vacation\b/, weight: 3 },
    { pattern: /\b(automated|auto[- ]?reply|auto-response)\b/, weight: 3 },
    { pattern: /\bi am (currently )?(away|unavailable)\b/, weight: 2 },
    { pattern: /\breturn(ing)? on\b/, weight: 1 },
    { pattern: /\blimited access to email\b/, weight: 2 },
  ],
  positive: [
    { pattern: /\b(happy|glad|would love) to (chat|talk|connect|hop on)\b/, weight: 4 },
    { pattern: /\blet'?s (chat|talk|connect|set up|schedule|hop on)\b/, weight: 4 },
    { pattern: /\b(send|share) (me )?(your )?(resume|cv|portfolio|availability)\b/, weight: 4 },
    { pattern: /\bwhat'?s your availability\b/, weight: 3 },
    { pattern: /\bhow does (next week|this week|tomorrow|friday|monday|tuesday|wednesday|thursday) (work|look)\b/, weight: 3 },
    { pattern: /\b(schedule|set up|book) (a )?(call|meeting|chat)\b/, weight: 3 },
    { pattern: /\b(great|good|interesting) (profile|background|experience|fit)\b/, weight: 2 },
    { pattern: /\bi'?d like to (learn|hear|know) more\b/, weight: 3 },
    { pattern: /\bthanks for reaching out\b.+\b(interested|chat|connect|discuss)/is, weight: 3 },
    { pattern: /\bcalendly\b/, weight: 3 },
    { pattern: /\bhappy to (help|support|refer|introduce)\b/, weight: 3 },
  ],
  referral: [
    { pattern: /\b(reach out|connect|talk|contact|email|chat) (to|with|you (with|to)) (our|the|my)? ?(recruiter|recruiting|talent|hiring manager)\b/, weight: 4 },
    { pattern: /\b(connect|introduce|intro'?ing|introducing) you (with|to)\b/, weight: 4 },
    { pattern: /\b(forwarding|forwarded|passing|sending|connecting) (this|it|you|your (email|note|message|resume|info))/, weight: 3 },
    { pattern: /\bcc'?ing\b/, weight: 2 },
    { pattern: /\b(you should|i'?d recommend|i'?d suggest) (talking|speaking|reaching out|connecting|chatting) (to|with)\b/, weight: 3 },
    { pattern: /\b(point|refer|direct) you (to|towards)\b/, weight: 3 },
  ],
  // "Confused" replies are the person ENGAGING but unable to decode the ask.
  // They outrank not_interested signals like "can't help" because the right
  // move is a one-line clarification, not closing the thread.
  confused: [
    { pattern: /\bnot sure what you('| a)?re asking\b/, weight: 5 },
    { pattern: /\bwhat (exactly )?are you asking\b/, weight: 5 },
    { pattern: /\bwhat is it (that )?you('| a)?re (asking|looking for)\b/, weight: 5 },
    { pattern: /\bi don'?t understand (what|your|the)\b/, weight: 4 },
    { pattern: /\bnot (sure|clear) (what|how) (you need|i can help)\b/, weight: 4 },
    { pattern: /\bhow (can|could) i help\b/, weight: 2 },
    { pattern: /\bwhat (do you need|can i do) (from|for) (me|you)\b/, weight: 3 },
    { pattern: /\bwhat is this (about|regarding|in reference to)\b/, weight: 4 },
    { pattern: /\bcan you clarify\b/, weight: 4 },
    { pattern: /\bwhat role (are you|is this)\b/, weight: 3 },
  ],
  not_interested: [
    { pattern: /\b(no|not) (currently |right now )?(hiring|open roles|openings|open positions)\b/, weight: 4 },
    { pattern: /\b(role|position|req) (has been |is )?(filled|closed)\b/, weight: 4 },
    { pattern: /\bunfortunately (we|i)\b/, weight: 2 },
    { pattern: /\bnot (the right|a good) fit\b/, weight: 4 },
    { pattern: /\bnot (interested|looking|hiring)\b/, weight: 3 },
    { pattern: /\bplease (remove|unsubscribe|take me off)\b/, weight: 4 },
    { pattern: /\bdo not (contact|email)\b/, weight: 4 },
    { pattern: /\bwon'?t be able to\b/, weight: 2 },
    { pattern: /\bcan'?t help\b/, weight: 2 },
  ],
};

export function classifyReplyText(text) {
  const body = String(text || "").toLowerCase();
  if (!body.trim()) {
    return { classification: "unclear", confidence: 0, reasons: ["empty body"] };
  }

  const scores = {};
  const reasons = {};
  for (const [label, rules] of Object.entries(CLASSIFIER_RULES)) {
    let total = 0;
    const hits = [];
    for (const rule of rules) {
      if (rule.pattern.test(body)) {
        total += rule.weight;
        hits.push(rule.pattern.source.slice(0, 60));
      }
    }
    if (total > 0) {
      scores[label] = total;
      reasons[label] = hits;
    }
  }

  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    return { classification: "unclear", confidence: 0, reasons: ["no rule matched"] };
  }
  const [topLabel, topScore] = entries[0];
  const secondScore = entries[1]?.[1] ?? 0;
  // Confidence: how dominant the top category is, soft-capped at 1.0.
  const confidence = Math.min(1, (topScore - secondScore) / 5 + 0.3);
  return {
    classification: topLabel,
    confidence: Number(confidence.toFixed(2)),
    reasons: reasons[topLabel] || [],
  };
}

// Optional LLM classifier (--llm). Uses the Anthropic API when
// ANTHROPIC_API_KEY is set; any failure falls back to the rule-based path so
// the cron never breaks on API hiccups.
const LLM_CATEGORIES = [
  "positive",
  "referral",
  "confused",
  "not_interested",
  "auto_reply",
  "unclear",
];

export async function classifyReplyTextLlm(text) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }
  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content:
            `You classify replies to a job-seeker's cold outreach email. ` +
            `Categories: positive (wants to continue / help), referral (redirects to someone else), ` +
            `confused (engaged but cannot tell what is being asked), not_interested (closed door), ` +
            `auto_reply (out-of-office/automated), unclear (none of the above). ` +
            `Reply with exactly one category word.\n\nReply text:\n${String(text || "").slice(0, 2000)}`,
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  const raw = String(data?.content?.[0]?.text || "").trim().toLowerCase();
  const label = LLM_CATEGORIES.find((c) => raw.includes(c));
  if (!label) {
    throw new Error(`Unrecognized LLM label: "${raw}"`);
  }
  return { classification: label, confidence: 0.9, reasons: [`llm:${model}`] };
}

// ---------- Helpers ----------

function flattenBody(payload) {
  if (!payload) return "";
  let out = "";
  if (payload.body?.data) {
    out += Buffer.from(payload.body.data, "base64url").toString("utf8") + "\n";
  }
  for (const part of payload.parts || []) {
    out += flattenBody(part);
  }
  return out;
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Strip the quoted prior message so classifier rules only see the new reply.
function dropQuotedHistory(text) {
  const markers = [
    /\nOn .+ wrote:\n/i,
    /\nOn .+ <[^>]+> wrote:/i,
    /\n-{2,}\s*Original Message\s*-{2,}/i,
    /\nFrom: .+\nSent: /i,
    /\nSent from my iPhone\b/i,
  ];
  let t = text;
  for (const m of markers) {
    const match = t.match(m);
    if (match) {
      t = t.slice(0, match.index);
    }
  }
  return t.trim();
}

function emailFromHeader(value) {
  if (!value) return "";
  const m = value.match(/<([^>]+)>/);
  return (m ? m[1] : value).trim().toLowerCase();
}

async function fetchLatestReply(accessToken, threadId, senderEmail) {
  const thread = await getThread(accessToken, threadId, "full");
  const msgs = thread.messages || [];
  // Walk backwards; the latest message that's not from us is the reply.
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    const headers = m.payload?.headers || [];
    const fromRaw = getHeader(headers, "From") || "";
    const fromAddr = emailFromHeader(fromRaw);
    if (senderEmail && fromAddr === senderEmail.toLowerCase()) continue;
    const bodyText = flattenBody(m.payload);
    const plain = stripHtml(bodyText);
    const cleaned = dropQuotedHistory(plain);
    return {
      from: fromAddr,
      fromRaw,
      subject: getHeader(headers, "Subject") || "",
      date: getHeader(headers, "Date") || "",
      internalDate: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
      bodyText: cleaned,
      bodyTextFull: plain,
    };
  }
  return null;
}

// ---------- Main ----------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
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

async function ensureRepliesHeader(accessToken, spreadsheetId) {
  const range = `${REPLIES_SHEET_NAME}!A1:${String.fromCharCode(64 + REPLIES_HEADERS.length)}1`;
  try {
    const existing = await getSheetValues(accessToken, spreadsheetId, range);
    const row0 = existing?.values?.[0] || [];
    if (row0.length && row0[0] === REPLIES_HEADERS[0]) return; // header present
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/unable to parse range/i.test(msg) && !/not found/i.test(msg)) throw err;
    // Sheet missing — we'll create it by appending; Sheets API auto-creates
    // new rows when using append with valueInputOption=USER_ENTERED only if
    // the sheet exists. Tell the user to run Setup once.
    throw new Error(
      `Replies sheet is missing. Open the spreadsheet and run the menu item "Outreach Sequencer > Setup Sheet" (or create a tab named "${REPLIES_SHEET_NAME}" manually), then re-run.`
    );
  }
  // Sheet exists but has no header — write it.
  await appendSheetValues(
    accessToken,
    spreadsheetId,
    `${REPLIES_SHEET_NAME}!A1`,
    [REPLIES_HEADERS]
  );
}

async function readRepliesSheet(accessToken, spreadsheetId) {
  const range = `${REPLIES_SHEET_NAME}!A:${String.fromCharCode(64 + REPLIES_HEADERS.length)}`;
  let values;
  try {
    values = await getSheetValues(accessToken, spreadsheetId, range);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unable to parse range/i.test(msg) || /not found/i.test(msg)) return { rows: [], alreadyClassified: new Set() };
    throw err;
  }
  const rows = values?.values ?? [];
  const alreadyClassified = new Set();
  for (let i = 1; i < rows.length; i += 1) {
    const queueRow = String(rows[i][0] ?? "").trim();
    if (queueRow) alreadyClassified.add(queueRow);
  }
  return { rows, alreadyClassified };
}

async function readQueueRepliedRows(accessToken, spreadsheetId) {
  const range = `${OUTREACH_SHEET_NAMES.QUEUE}!A:AB`;
  const values = await getSheetValues(accessToken, spreadsheetId, range);
  const rows = values?.values ?? [];
  if (rows.length < 2) return [];
  const statusIdx = OUTREACH_QUEUE_HEADERS.indexOf("status");
  const threadIdx = OUTREACH_QUEUE_HEADERS.indexOf("gmail_thread_id");
  const senderIdx = OUTREACH_QUEUE_HEADERS.indexOf("sender_email");
  const recipientIdx = OUTREACH_QUEUE_HEADERS.indexOf("recipient_email");
  const companyIdx = OUTREACH_QUEUE_HEADERS.indexOf("company");
  const nameIdx = OUTREACH_QUEUE_HEADERS.indexOf("contact_name");
  const subjectIdx = OUTREACH_QUEUE_HEADERS.indexOf("subject");
  const replyDetectedIdx = OUTREACH_QUEUE_HEADERS.indexOf("reply_detected_at");

  const out = [];
  for (let i = 1; i < rows.length; i += 1) {
    const r = rows[i];
    const status = String(r[statusIdx] ?? "").toLowerCase();
    if (status !== "replied") continue;
    const threadId = String(r[threadIdx] ?? "").trim();
    if (!threadId) continue;
    out.push({
      queueRow: i + 1, // 1-indexed sheet row number (header is row 1)
      threadId,
      senderEmail: String(r[senderIdx] ?? "").trim(),
      recipientEmail: String(r[recipientIdx] ?? "").trim(),
      company: String(r[companyIdx] ?? "").trim(),
      contactName: String(r[nameIdx] ?? "").trim(),
      subject: String(r[subjectIdx] ?? "").trim(),
      replyDetectedAt: String(r[replyDetectedIdx] ?? "").trim(),
    });
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const spreadsheetId = args["spreadsheet-id"] ?? getOutreachSpreadsheetId();
  const dryRun = args["dry-run"] === "true";
  const summaryOnly = args["summary-only"] === "true";
  const limit = args.limit ? Number(args.limit) : Infinity;

  const { accessToken: sheetsToken } = await getSheetsAccessToken(args);
  const { oauthPath, credentialsPath } = getDefaultOauthPaths(args);
  const gmailToken = await getAccessToken(oauthPath, credentialsPath);

  if (!summaryOnly) {
    await ensureRepliesHeader(sheetsToken, spreadsheetId);
  }

  const { rows: repliesRows, alreadyClassified } = await readRepliesSheet(
    sheetsToken,
    spreadsheetId
  );

  if (summaryOnly) {
    printSummary(repliesRows);
    return;
  }

  const repliedRows = await readQueueRepliedRows(sheetsToken, spreadsheetId);
  const toClassify = repliedRows.filter(
    (r) => !alreadyClassified.has(String(r.queueRow))
  );

  if (!toClassify.length) {
    console.error("[classifier] No new replies to classify.");
    printSummary(repliesRows);
    return;
  }

  console.error(
    `[classifier] Found ${toClassify.length} new replied row(s). Processing up to ${Math.min(
      toClassify.length,
      limit
    )}.`
  );

  const appendedRows = [];
  for (const row of toClassify.slice(0, limit)) {
    try {
      const reply = await fetchLatestReply(gmailToken, row.threadId, row.senderEmail);
      if (!reply) {
        console.error(`  row ${row.queueRow}: no inbound message found in thread`);
        continue;
      }
      let result;
      if (args.llm === "true") {
        try {
          result = await classifyReplyTextLlm(reply.bodyText);
        } catch (llmErr) {
          console.error(
            `  row ${row.queueRow}: LLM classify failed (${llmErr instanceof Error ? llmErr.message : llmErr}); using rules`
          );
          result = classifyReplyText(reply.bodyText);
        }
      } else {
        result = classifyReplyText(reply.bodyText);
      }
      const { classification, confidence, reasons } = result;
      const snippet = reply.bodyText.slice(0, 240);
      // confused is actionable: a one-line clarification within 24h usually
      // recovers the thread (see COLD_EMAIL_PLAYBOOK.md "Reply handling").
      const needsAction =
        classification === "positive" ||
        classification === "referral" ||
        classification === "confused";
      const outputRow = [
        String(row.queueRow),
        new Date().toISOString(),
        row.company,
        row.contactName,
        row.recipientEmail,
        row.subject,
        classification,
        String(confidence),
        snippet,
        reply.internalDate || row.replyDetectedAt || "",
        needsAction ? "yes" : "no",
        "no",
        reasons.slice(0, 2).join(" | "),
      ];
      appendedRows.push(outputRow);
      console.error(
        `  row ${row.queueRow} (${row.contactName || row.recipientEmail}): ${classification} (conf ${confidence})`
      );
    } catch (err) {
      console.error(`  row ${row.queueRow} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (!appendedRows.length) {
    console.error("[classifier] No rows classified.");
    printSummary(repliesRows);
    return;
  }

  if (dryRun) {
    console.error(`[classifier] --dry-run: would append ${appendedRows.length} row(s).`);
  } else {
    await appendSheetValues(
      sheetsToken,
      spreadsheetId,
      `${REPLIES_SHEET_NAME}!A:A`,
      appendedRows
    );
    console.error(`[classifier] Appended ${appendedRows.length} row(s) to ${REPLIES_SHEET_NAME}.`);
  }

  // Recompute summary including the new rows we just appended.
  const allRows = [...repliesRows, ...appendedRows.map((r) => r.slice())];
  printSummary(allRows);
}

function printSummary(repliesRows) {
  if (repliesRows.length < 2) {
    console.error("[summary] No classified replies yet.");
    return;
  }
  const header = repliesRows[0];
  const classifyIdx = header.indexOf("classification");
  const needsIdx = header.indexOf("needs_action");
  const actionedIdx = header.indexOf("actioned");
  const companyIdx = header.indexOf("company");
  const nameIdx = header.indexOf("contact_name");
  const subjIdx = header.indexOf("subject");
  const snippetIdx = header.indexOf("snippet");

  const counts = {};
  const positivesWaiting = [];
  for (let i = 1; i < repliesRows.length; i += 1) {
    const r = repliesRows[i];
    const cls = String(r[classifyIdx] ?? "unclear").toLowerCase();
    counts[cls] = (counts[cls] || 0) + 1;
    const needs = String(r[needsIdx] ?? "no").toLowerCase() === "yes";
    const done = String(r[actionedIdx] ?? "no").toLowerCase() === "yes";
    if (needs && !done) {
      positivesWaiting.push({
        company: r[companyIdx] || "",
        name: r[nameIdx] || "",
        subject: r[subjIdx] || "",
        snippet: (r[snippetIdx] || "").slice(0, 120),
        classification: cls,
      });
    }
  }

  console.error("");
  console.error("==================== REPLY SUMMARY ====================");
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.error(`  ${k.padEnd(16)} ${v}`);
  }
  console.error(`  ${"—".repeat(30)}`);
  console.error(`  ${positivesWaiting.length} reply(ies) need action (positive/referral/confused, not yet actioned)`);
  if (positivesWaiting.length) {
    console.error("");
    for (const p of positivesWaiting) {
      console.error(`  * [${p.classification}] ${p.company} — ${p.name}`);
      console.error(`      "${p.subject}"`);
      console.error(`      ${p.snippet}${p.snippet.length >= 120 ? "…" : ""}`);
    }
  }
  console.error("=======================================================");
}

import { pathToFileURL } from "node:url";
const isDirect =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
