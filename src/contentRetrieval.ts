import { type RankedFile } from "./retrieval.js";

export type SourceFile = {
  path: string;
  content: string;
};

export function rankFileContents(
  issueDescription: string,
  files: SourceFile[],
): RankedFile[] {
  const result: RankedFile[] = [];

  const removedWords: string[] = [
    `the`,
    `and`,
    `for`,
    `with`,
    `when`,
    `this`,
    `that`,
    `from`,
  ];
  const modifiedIssueDescription: string[] = issueDescription
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  let uniqueDescriptionTerms: string[] = [];

  for (const word of modifiedIssueDescription) {
    if (!removedWords.includes(word) && word.length >= 3) {
      uniqueDescriptionTerms.push(word);
    }
  }
  uniqueDescriptionTerms = [...new Set(uniqueDescriptionTerms)];

  const knownFilePath = new Set<string>();

  for (const file of files) {
    if (knownFilePath.has(file.path)) {
      continue;
    }

    knownFilePath.add(file.path);
    let matchedTerms: string[] = [];
    for (const term of uniqueDescriptionTerms) {
      if (
        file.path.toLowerCase().includes(term) ||
        file.content.toLowerCase().includes(term)
      ) {
        matchedTerms.push(term);
      }
    }

    const score: number = matchedTerms.length;

    if (score > 0) {
      result.push({
        path: file.path,
        score: score,
        matchedTerms: matchedTerms,
      });
    }
  }

  result.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }

    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });

  return result;
}
