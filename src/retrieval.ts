export type RankedFile = {
  path: string;
  score: number;
  matchedTerms: string[];
};

export function rankFilePaths(
  issueDescription: string,
  paths: string[],
): RankedFile[] {
  if (issueDescription === null || paths === null) {
    throw new Error();
  }
  let result: RankedFile[] = [];
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

  const uniquePaths: string[] = [...new Set(paths)];

  for (const path of uniquePaths) {
    let matchedTerms: string[] = [];
    for (const term of uniqueDescriptionTerms) {
      if (path.toLowerCase().includes(term)) {
        matchedTerms.push(term);
      }
    }

    const score: number = matchedTerms.length;

    if (score > 0) {
      result.push({ path: path, score: score, matchedTerms: matchedTerms });
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

  return result.slice(0, 5);
}
