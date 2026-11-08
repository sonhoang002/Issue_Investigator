import { Buffer } from "node:buffer";

export class customError extends Error {
  public status: number;

  constructor(message: string, errorCode: number, field?: string) {
    super(message);
    this.status = errorCode;
    this.name = "CustomValidationError";
  }
}

type RepositorySummary = {
  name: string;
  fullName: string;
  description: string | null;
  defaultBranch: string;
  htmlUrl: string;
};

type GitHubRepository = {
  name: string;
  full_name: string;
  description: string | null;
  default_branch: string;
  html_url: string;
};

type RepositoryEntry = {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
};

type GitHubFileResponse = {
  type: "file";
  encoding: "base64";
  name: string;
  path: string;
  sha: string;
  content: string;
  size: number;
};

type RepositoryFile = {
  name: string;
  path: string;
  sha: string;
  content: string;
};

type GithubTreeEntry = {
  path: string;
  mode: string;
  type: string;
};

type GithubGetATree = {
  truncated: boolean;
  tree: unknown[];
};

function isValidGithubTreeArray(data: unknown): data is GithubTreeEntry {
  return (
    typeof data === "object" &&
    !Array.isArray(data) &&
    data !== null &&
    "path" in data &&
    typeof data.path === "string" &&
    data.path.length > 0 &&
    "mode" in data &&
    typeof data.mode === "string" &&
    "type" in data &&
    typeof data.type === "string"
  );
}

function isValidGithubGetATree(data: unknown): data is GithubGetATree {
  return (
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    "truncated" in data &&
    typeof data.truncated === "boolean" &&
    "tree" in data &&
    Array.isArray(data.tree)
  );
}

function isValidGithubSummary(data: unknown): data is GitHubRepository {
  return (
    typeof data === "object" &&
    data !== null &&
    "name" in data &&
    typeof data.name === "string" &&
    "full_name" in data &&
    typeof data.full_name === "string" &&
    "description" in data &&
    (typeof data.description === "string" || data.description === null) &&
    "default_branch" in data &&
    typeof data.default_branch === "string" &&
    "html_url" in data &&
    typeof data.html_url === "string"
  );
}

function isValidGithubContent(data: unknown): data is RepositoryEntry {
  return (
    typeof data === "object" &&
    data !== null &&
    "name" in data &&
    typeof data.name === "string" &&
    "path" in data &&
    typeof data.path === "string" &&
    "type" in data &&
    (data.type === "file" ||
      data.type === "dir" ||
      data.type === "symlink" ||
      data.type === "submodule")
  );
}

function isValidBase64Object(data: unknown): data is GitHubFileResponse {
  return (
    typeof data === "object" &&
    data !== null &&
    "name" in data &&
    typeof data.name === "string" &&
    "path" in data &&
    typeof data.path === "string" &&
    "sha" in data &&
    typeof data.sha === "string" &&
    "content" in data &&
    typeof data.content === "string" &&
    "size" in data &&
    typeof data.size === "number" &&
    Number.isInteger(data.size) &&
    data.size >= 0 &&
    data.size <= 100_000
  );
}

function isBase64File(data: unknown): boolean {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return false;
  }

  if (!("type" in data) || data.type !== "file") {
    return false;
  }

  if (!("encoding" in data) || data.encoding !== "base64") {
    return false;
  }

  if (!("content" in data) || typeof data.content !== "string") {
    return false;
  }

  return true;
}

export async function getRepositorySummary(
  owner: string,
  repo: string,
): Promise<RepositorySummary> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      {
        signal: AbortSignal.timeout(10_000),
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "issue-investigator",
        },
      },
    );

    if (!response.ok) {
      if (response.status === 404) {
        throw new customError(`REPOSITORY_NOT_FOUND`, 404);
      } else {
        throw new customError(`GITHUB_REQUEST_FAILED`, 502);
      }
    }

    const data: unknown = await response.json();

    if (!isValidGithubSummary(data)) {
      throw new customError("GITHUB_REQUEST_FAILED", 502);
    }

    return {
      name: data.name,
      fullName: data.full_name,
      description: data.description,
      defaultBranch: data.default_branch,
      htmlUrl: data.html_url,
    };
  } catch (error) {
    if (error instanceof customError) {
      throw error;
    }

    // if (error instanceof Error && error.name === "TimeoutError") {
    //   throw new customError("GITHUB_TIMEOUT", 504);
    // }

    throw new customError(`GITHUB_REQUEST_FAILED`, 502);
  }
}

export async function listRepositoryRoot(
  owner: string,
  repo: string,
): Promise<RepositoryEntry[]> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents`,
      {
        signal: AbortSignal.timeout(10_000),
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "issue-investigator",
        },
      },
    );

    if (!response.ok) {
      if (response.status === 404) {
        throw new customError(`REPOSITORY_NOT_FOUND`, 404);
      } else {
        throw new customError(`GITHUB_REQUEST_FAILED`, 502);
      }
    }

    const data: unknown = await response.json();

    if (!Array.isArray(data)) {
      throw new customError("GITHUB_REQUEST_FAILED", 502);
    }

    if (!data.every((section) => isValidGithubContent(section))) {
      throw new customError("GITHUB_REQUEST_FAILED", 502);
    }

    const modifiedData = data.map((eachObject) => ({
      name: eachObject.name,
      path: eachObject.path,
      type: eachObject.type,
    }));

    return modifiedData;
  } catch (error) {
    if (error instanceof customError) {
      throw error;
    }

    throw new customError(`GITHUB_REQUEST_FAILED`, 502);
  }
}

export async function readRepositoryFile(
  owner: string,
  repo: string,
  filePath: string,
): Promise<RepositoryFile> {
  try {
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new customError("INVALID_FILE_PATH", 400);
    }

    const decoder = new TextDecoder("utf-8", { fatal: true });
    const filePathArray: string[] = filePath.split("/");

    for (let i = 0; i < filePathArray.length; i++) {
      const segment = filePathArray[i];

      if (
        segment === undefined ||
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\\") ||
        segment.includes("\0")
      ) {
        throw new customError("INVALID_FILE_PATH", 400);
      }

      filePathArray[i] = encodeURIComponent(segment);
    }

    const encodedFilePath = filePathArray.join("/");

    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedFilePath}`,
      {
        signal: AbortSignal.timeout(10_000),
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "issue-investigator",
        },
      },
    );

    if (!response.ok) {
      if (response.status === 404) {
        throw new customError(`FILE_NOT_FOUND`, 404);
      } else {
        throw new customError(`GITHUB_REQUEST_FAILED`, 502);
      }
    }

    const data: unknown = await response.json();
    if (!isBase64File(data) || !isValidBase64Object(data)) {
      throw new customError("GITHUB_REQUEST_FAILED", 502);
    }

    const normalizedContent = data.content.replace(/[ \t\r\n]/g, "");
    const decodedContent = Buffer.from(normalizedContent, "base64");

    if (
      decodedContent.length !== data.size ||
      decodedContent.length > 100_000
    ) {
      throw new customError("GITHUB_REQUEST_FAILED", 502);
    }

    if (decodedContent.toString("base64") !== normalizedContent) {
      throw new customError("GITHUB_REQUEST_FAILED", 502);
    }

    const text = decoder.decode(decodedContent);

    return {
      name: data.name,
      path: data.path,
      sha: data.sha,
      content: text,
    };
  } catch (error) {
    if (error instanceof customError) {
      throw error;
    }

    throw new customError(`GITHUB_REQUEST_FAILED`, 502);
  }
}

export async function listRepositoryFilePaths(
  owner: string,
  repo: string,
  ref: string,
): Promise<string[]> {
  try {
    if (typeof ref !== "string" || ref.trim().length === 0) {
      throw new customError("INVALID_REPOSITORY_REF", 400);
    }

    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      {
        signal: AbortSignal.timeout(10_000),
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "issue-investigator",
        },
      },
    );

    if (!response.ok) {
      if (response.status === 404) {
        throw new customError(`REPOSITORY_OR_REF_NOT_FOUND`, 404);
      } else {
        throw new customError(`GITHUB_REQUEST_FAILED`, 502);
      }
    }

    const data: unknown = await response.json();

    if (!isValidGithubGetATree(data)) {
      throw new customError("GITHUB_REQUEST_FAILED", 502);
    }

    if (data.truncated) {
      throw new customError("REPOSITORY_TREE_TRUNCATED", 502);
    }

    if (data.tree.length > 10_000) {
      throw new customError("REPOSITORY_TREE_TOO_LARGE", 502);
    }

    const treeTypeModeMap = new Map<string, string[]>([
      ["blob", ["100644", "100755", "120000"]],
      ["tree", ["040000"]],
      ["commit", ["160000"]],
    ]);

    let result: string[] = [];

    for (const tree of data.tree) {
      if (!isValidGithubTreeArray(tree)) {
        throw new customError("GITHUB_REQUEST_FAILED", 502);
      }

      if (
        !treeTypeModeMap.has(tree.type) ||
        !treeTypeModeMap.get(tree.type)?.includes(tree.mode)
      ) {
        throw new customError("GITHUB_REQUEST_FAILED", 502);
      }

      const segments = tree.path.split("/");

      for (const segment of segments) {
        if (
          segment === undefined ||
          segment === "" ||
          segment === "." ||
          segment === ".." ||
          segment.includes("\\") ||
          segment.includes("\0")
        ) {
          throw new customError("GITHUB_REQUEST_FAILED", 502);
        }
      }

      if (
        tree.type === "blob" &&
        (tree.mode === "100644" || tree.mode === "100755")
      ) {
        result.push(tree.path);
      }
    }

    return [...new Set(result)];
  } catch (error) {
    if (error instanceof customError) {
      throw error;
    }

    throw new customError(`GITHUB_REQUEST_FAILED`, 502);
  }
}
