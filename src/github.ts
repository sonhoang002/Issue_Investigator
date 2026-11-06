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
