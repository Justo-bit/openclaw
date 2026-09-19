#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import { finishGuard, openGuard, withApprovalRequest } from "./guard-review.mjs";
import { createIssueMutationHelpers, sanitizeGuardDisplayValue } from "./guard-shared.mjs";
import { loadSecurityReviewPolicy } from "./security-review-policy.mjs";

const marker = "<!-- openclaw:security-sensitive-guard -->";
const changedLabel = "security-sensitive-changed";
const reviewLabel = "security-review-required";

function code(value) {
  return `\`${sanitizeGuardDisplayValue(value).replaceAll("`", "\\`")}\``;
}

function renderComment({ changes, pullRequest, approval }) {
  const heading =
    changes.length === 0
      ? "Security-sensitive guard cleared"
      : approval?.kind === "author"
        ? "Security-sensitive changes noted"
        : approval
          ? "Maintainer security review complete"
          : "Maintainer security review required";
  const lines = [
    marker,
    "",
    `### ${heading}`,
    "",
    `Current revision: ${code(pullRequest.head.sha)}`,
  ];
  if (changes.length === 0) {
    lines.push("", "This PR no longer changes files in the maintainer security-review tier.");
  } else {
    lines.push("", "Review these security responsibilities:", "");
    for (const change of changes.slice(0, 25)) {
      lines.push(`- ${code(change.path)}: ${change.reason}`);
    }
    if (changes.length > 25) {
      lines.push(`- ${changes.length - 25} additional sensitive files; see the workflow summary.`);
    }
    lines.push("");
    if (approval?.kind === "author") {
      lines.push(
        `Informational: author @${approval.login} has repository ${code(approval.role)} access.`,
      );
    } else if (approval) {
      lines.push(
        `@${approval.login} approved this revision with ${code("/allow-security-sensitive-change")} and repository ${code(approval.role)} access.`,
      );
    } else {
      lines.push(
        "A GitHub user account with repository `maintain` or `admin` access must post a new comment containing `/allow-security-sensitive-change` after this notice names the current revision. SecOps approval is not required for this tier.",
        "Use only the command, or include `/allow-dependencies-change` on a separate line if both guards need approval. A normal GitHub Approve review does not satisfy this check.",
      );
    }
    lines.push(
      "",
      "A later push requires a new approval comment after the notice updates. Editing an old comment does not renew approval; deleting the command removes its approval.",
    );
  }
  lines.push(
    "",
    "Separate CODEOWNERS requirements still apply to security policy and enforcement files.",
  );
  return lines.join("\n");
}

export async function reviewSecuritySensitiveChanges(prepared) {
  const guard = await openGuard(
    {
      context: "openclaw/security-sensitive-review",
      commentMarker: marker,
      approvalCommand: "/allow-security-sensitive-change",
    },
    prepared,
  );
  if (!guard) {
    return;
  }
  const { api, owner, repo, issuePath, files, pullRequest } = guard;
  const { collectSecuritySensitiveChanges } = loadSecurityReviewPolicy();
  const changes = collectSecuritySensitiveChanges(files);
  const [comments, labels] = await Promise.all([
    api.paginate(`${issuePath}/comments`),
    api.paginate(`${issuePath}/labels`),
  ]);
  const existing = comments.find(
    (comment) => comment.user?.login === "github-actions[bot]" && comment.body?.startsWith(marker),
  );
  const { addLabelIfMissing, removeLabelIfPresent, upsertComment } = createIssueMutationHelpers({
    api,
    owner,
    repo,
    issuePath,
    labelNames: new Set(labels.map((label) => label.name)),
  });
  const allowed = await finishGuard(guard, {
    requiresApproval: changes.length > 0,
    description:
      changes.length > 0
        ? "Sensitive changes have maintainer authority"
        : "No sensitive product changes",
  });
  if (changes.length > 0) {
    await addLabelIfMissing(changedLabel);
  } else {
    await removeLabelIfPresent(changedLabel);
  }
  if (allowed) {
    await removeLabelIfPresent(reviewLabel);
  } else {
    await addLabelIfMissing(reviewLabel);
  }
  const body = withApprovalRequest(
    guard,
    renderComment({ changes, pullRequest, approval: guard.approval }),
  );
  if (changes.length > 0 || existing) {
    await upsertComment(existing, body);
  }
  const summary = [
    body,
    "",
    ...changes.slice(25).map((change) => `- ${code(change.path)}: ${change.reason}`),
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  } else {
    console.log(summary);
  }
  if (!allowed) {
    throw new Error("A maintainer must approve the current revision's sensitive changes.");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  reviewSecuritySensitiveChanges().catch(
    /** @param {unknown} error */ (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
