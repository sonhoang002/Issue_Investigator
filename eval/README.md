# Offline retrieval experiment

Run from the application directory with existing dependencies installed:

```powershell
node --import tsx eval/content-retrieval.mjs ../fraudguard ../smoke-runs/evidence-9b0f46057a314c41b940834a75a8c5bb.json ../smoke-runs
```

The arguments are a local Git repository, a saved successful evidence response, and an output directory. The baseline must record an immutable commit as both its requested ref and resolved commit. The runner preserves the original artifact and writes a uniquely named JSON result. Case artifacts stay outside this application repository.

The runner reads pinned Git objects without executing retrieved source or making network/model calls. It checks the baseline path ranking and candidate count, preflights source-pool byte/file limits, then compares filename and content scoring on the same pool. The JSON records exclusions, source blob IDs, bytes, all content ranks, top-three comparisons, local timings, and hashes of the baseline and ranking/runner implementations.

Pool policy: regular/executable `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.py`, `.sql` files. Exclude dependency/generated/environment directories listed in the script and `.min.js`/`.d.ts` suffixes. Include source tests. Stop on invalid UTF-8, read failures, more than 100 files, any file over 100,000 bytes, or more than 2,000,000 total bytes. Oversized pools are not silently truncated. Git subprocesses have a ten-second timeout and a four-million-byte output cap each; this is not a whole-run deadline.

Run all behavior checks with `npm.cmd test`; the three harness checks cover filtering, budget boundaries, and tree parsing. The actual local run also asserts commit resolution, candidate count, baseline ranking, and each loaded blob size.

Review relevance separately after ranking. Expected answers do not enter the scoring input. A source-reviewed development case is not benchmark ground truth; local timings do not measure GitHub request cost. No production endpoint uses this runner or the content ranker yet.
