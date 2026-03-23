import { z } from 'zod';

// ---------------------------------------------------------------------------
// Linear CLI output schemas (lineark)
// ---------------------------------------------------------------------------

export const LinearIssueSummarySchema = z.object({
  identifier: z.string(),
  title: z.string().optional(),
  state: z.string().optional(),
}).passthrough();

export const LinearIssueListSchema = z.array(LinearIssueSummarySchema);

export const LinearIssueDetailSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().optional().default(''),
}).passthrough();

// ---------------------------------------------------------------------------
// GitHub CLI output schemas (gh)
// ---------------------------------------------------------------------------

export const GHPRListItemSchema = z.object({
  number: z.number(),
});

export const GHPRListSchema = z.array(GHPRListItemSchema);

export const GHPRViewSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  headRefName: z.string(),
  reviewDecision: z.string().nullable().optional().default(''),
  mergeable: z.string().optional().default('UNKNOWN'),
  statusCheckRollup: z.array(z.object({
    name: z.string(),
    status: z.string().optional().default(''),
    conclusion: z.string().nullable().optional().default(''),
  })).optional().default([]),
  commits: z.array(z.object({
    committedDate: z.string(),
  })).optional().default([]),
  reviews: z.array(z.object({
    submittedAt: z.string().optional().default(''),
    state: z.string().optional().default(''),
    author: z.object({
      login: z.string(),
    }).optional(),
    body: z.string().optional().default(''),
  })).optional().default([]),
  comments: z.array(z.object({
    createdAt: z.string().optional().default(''),
    author: z.object({
      login: z.string(),
    }).optional(),
  })).optional().default([]),
});

export const GHPRReviewPollSchema = z.object({
  state: z.string().optional(),
  reviews: z.array(z.object({
    id: z.string().optional(),
    state: z.string().optional().default(''),
    body: z.string().optional().default(''),
    author: z.object({
      login: z.string(),
    }).optional(),
  })).optional().default([]),
});

export const GHRunListSchema = z.array(z.object({
  databaseId: z.number(),
  name: z.string(),
}));
