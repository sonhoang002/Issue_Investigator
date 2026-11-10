import { listRepositoryFilePaths, readRepositoryFile } from "./github.js";
import { rankFilePaths } from "./retrieval.js";
import { customError } from "./github.js";

export type EvidenceFile = {
  name: string;
  path: string;
  sha: string;
  content: string;
  score: number;
  matchedTerms: string[];
};

export type EvidenceBundle = {
  owner: string;
  repo: string;
  ref: string;
  candidateCount: number;
  files: EvidenceFile[];
};

export async function collectRepositoryEvidence(
  owner: string,
  repo: string,
  issueDescription: string,
  ref: string,
): Promise<EvidenceBundle> {
  if (
    typeof issueDescription !== "string" ||
    issueDescription.trim().length <= 0 ||
    issueDescription.trim().length > 4_000
  ) {
    throw new customError("INVALID_INVESTIGATION_INPUT", 400);
  }

  if (typeof ref !== "string" || ref.trim().length === 0) {
    throw new customError("INVALID_REPOSITORY_REF", 400);
  }

  const repoFilePaths: string[] = await listRepositoryFilePaths(
    owner,
    repo,
    ref,
  );
  const candidateCount: number = repoFilePaths.length;

  const rankedFile = rankFilePaths(issueDescription.trim(), repoFilePaths);
  const selectedRankedFile = rankedFile.slice(0, 3);

  const files: EvidenceFile[] = [];

  for (const file of selectedRankedFile) {
    const repoFiles = await readRepositoryFile(owner, repo, file.path, ref);

    files.push({
      name: repoFiles.name,
      path: repoFiles.path,
      sha: repoFiles.sha,
      content: repoFiles.content,
      score: file.score,
      matchedTerms: file.matchedTerms,
    });
  }

  return {
    owner,
    repo,
    ref,
    candidateCount,
    files,
  };
}
