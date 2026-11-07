import express, { type Request, type Response, type Express } from "express";
import {
  getRepositorySummary,
  listRepositoryRoot,
  readRepositoryFile,
  customError,
} from "./github.js";

export const app: Express = express();

function checkParamsValidity(owner: unknown, repo: unknown) {
  const ownerRegex = /^[a-zA-Z0-9-]+$/;
  const repoRegex = /^[a-zA-Z0-9._-]+$/;

  if (typeof owner !== "string" || typeof repo !== "string") {
    throw new customError("INVALID_REPOSITORY_INPUT", 400);
  }

  const ownerValid: boolean =
    ownerRegex.test(owner) && owner !== "." && owner !== "..";
  const repoValid: boolean =
    repoRegex.test(repo) && repo !== "." && repo !== "..";

  if (!ownerValid || !repoValid) {
    throw new customError("INVALID_REPOSITORY_INPUT", 400);
  }

  return { owner, repo };
}

app.get(
  "/api/repositories/:owner/:repo/file",
  async (req: Request, res: Response) => {
    try {
      const { owner, repo } = checkParamsValidity(
        req.params.owner,
        req.params.repo,
      );

      if (typeof req.query.path !== "string" || req.query.path.length === 0) {
        return res.status(400).json({ error: "INVALID_FILE_PATH" });
      }

      const response = await readRepositoryFile(owner, repo, req.query.path);

      return res.status(200).json(response);
    } catch (error) {
      if (error instanceof customError) {
        res.status(error.status).json({ error: error.message });
      } else {
        res.status(502).json({ error: "GITHUB_REQUEST_FAILED" });
      }
    }
  },
);

app.get(
  "/api/repositories/:owner/:repo/contents",
  async (req: Request, res: Response) => {
    try {
      const { owner, repo } = checkParamsValidity(
        req.params.owner,
        req.params.repo,
      );

      const response = await listRepositoryRoot(owner, repo);

      res.status(200).json(response);
    } catch (error) {
      if (error instanceof customError) {
        res.status(error.status).json({ error: error.message });
      } else {
        res.status(502).json({ error: "GITHUB_REQUEST_FAILED" });
      }
    }
  },
);

app.get(
  "/api/repositories/:owner/:repo",
  async (req: Request, res: Response) => {
    try {
      const { owner, repo } = checkParamsValidity(
        req.params.owner,
        req.params.repo,
      );

      const response = await getRepositorySummary(owner, repo);

      res.status(200).json(response);
    } catch (error) {
      if (error instanceof customError) {
        res.status(error.status).json({ error: error.message });
      } else {
        res.status(502).json({ error: "GITHUB_REQUEST_FAILED" });
      }
    }
  },
);
