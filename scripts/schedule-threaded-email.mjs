#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { writeJson } from "./gmail-api.mjs";

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const value = argv[i + 1];

    if (value === undefined || value.startsWith("--")) {
      args[key] = "true";
      continue;
    }

    args[key] = value;
    i += 1;
  }

  return args;
}

function ensureArg(args, key) {
  if (!args[key]) {
    throw new Error(`Missing required argument --${key}`);
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function addSeconds(date, seconds) {
  return new Date(date.getTime() + seconds * 1000);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureArg(args, "to");
  ensureArg(args, "subject");
  ensureArg(args, "main-html");
  ensureArg(args, "followup-html");

  const now = new Date();
  const mainDelaySeconds = Number(args["main-delay-seconds"] ?? 60);
  const followUpDelaySeconds = Number(args["followup-delay-seconds"] ?? 120);

  if (Number.isNaN(mainDelaySeconds) || Number.isNaN(followUpDelaySeconds)) {
    throw new Error("Delay values must be numeric.");
  }

  const mainScheduledAt = addSeconds(now, mainDelaySeconds);
  const followUpScheduledAt = addSeconds(mainScheduledAt, followUpDelaySeconds);

  const rootDir = process.cwd();
  const jobsDir = path.join(rootDir, "scheduler", "jobs");
  const logsDir = path.join(rootDir, "scheduler", "logs");
  await ensureDir(jobsDir);
  await ensureDir(logsDir);

  const jobId = `${now.toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const jobPath = path.join(jobsDir, `${jobId}.json`);
  const logPath = path.join(logsDir, `${jobId}.log`);

  const job = {
    id: jobId,
    createdAt: now.toISOString(),
    status: "queued",
    to: args.to,
    subject: args.subject,
    main: {
      html: args["main-html"],
      scheduledAt: mainScheduledAt.toISOString(),
    },
    followUp: {
      html: args["followup-html"],
      scheduledAt: followUpScheduledAt.toISOString(),
    },
    logPath,
  };

  await writeJson(jobPath, job);

  const outFd = await fs.open(logPath, "a");
  const child = spawn(process.execPath, ["scripts/run-threaded-email-job.mjs", jobPath], {
    cwd: rootDir,
    detached: true,
    stdio: ["ignore", outFd.fd, outFd.fd],
  });
  child.unref();
  await outFd.close();

  console.log(
    JSON.stringify(
      {
        jobId,
        jobPath,
        logPath,
        pid: child.pid,
        to: args.to,
        subject: args.subject,
        mainScheduledAt: mainScheduledAt.toISOString(),
        followUpScheduledAt: followUpScheduledAt.toISOString(),
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
