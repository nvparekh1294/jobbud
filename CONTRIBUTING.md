# Contributing to JobBud

Thanks for taking the time to contribute.

## Reporting bugs

Open an issue with a clear title and the following:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Your environment (OS, browser, Node version if relevant)

## Requesting a feature

Open an issue with the tag `enhancement`. Describe the use case, not just the feature — it helps to understand the problem you're trying to solve.

## Submitting a pull request

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Open a pull request with a clear description of what changed and why

Before submitting, please check the constraints below.

## Constraints

### Vercel Hobby plan: 12 serverless function limit

JobBud currently uses 9 of 12 allowed functions. Do not add new files to `api/` without opening an issue first to discuss consolidation. PRs that push the function count past 12 will fail to deploy and will not be merged.

### All integrations must fail silently

If an environment variable is not set, the related feature must degrade gracefully. No crashes, no unhelpful errors. This is a hard requirement — every optional integration must have a no-op path when its env vars are absent.

### DOCX upload is out of scope

The app supports PDF and plain text paste only. PRs adding DOCX upload will not be merged at this time.

### No personal data in PRs

Do not submit PRs that include real names, email addresses, API keys, job records, or any other personal information. Check your diff before opening a PR.

## Questions

Open an issue or start a discussion. Response time may vary — this is a solo-maintained project.
