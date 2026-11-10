import express, {
  type Request,
  type Response,
  type Express,
  type ErrorRequestHandler,
  type NextFunction,
} from "express";
import {
  getRepositorySummary,
  listRepositoryRoot,
  listRepositoryFilePaths,
  readRepositoryFile,
  customError,
} from "./github.js";

import { rankFilePaths } from "./retrieval.js";
import { collectRepositoryEvidence } from "./investigation.js";

export const app: Express = express();

const errorHandler: ErrorRequestHandler = (
  error: unknown,
  req,
  res,
  next: NextFunction,
) => {
  const type =
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    typeof error.type === "string"
      ? error.type
      : undefined;
  let statusCode: number = 500;
  let message: string = "INTERNAL_SERVER_ERROR";

  if (type === "entity.parse.failed") {
    statusCode = 400;
    message = "INVALID_JSON";
  } else if (type === "entity.too.large") {
    statusCode = 413;
    message = "REQUEST_BODY_TOO_LARGE";
  } else if (
    type === "charset.unsupported" ||
    type === "encoding.unsupported"
  ) {
    statusCode = 415;
    message = "UNSUPPORTED_BODY_ENCODING";
  }

  if (res.headersSent) return next(error);

  res.status(statusCode).json({
    error: message,
  });
};

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

app.post(
  "/api/repositories/:owner/:repo/candidates",
  express.json({ limit: "16kb", strict: false }),
  async (req: Request, res: Response) => {
    try {
      const { owner, repo } = checkParamsValidity(
        req.params.owner,
        req.params.repo,
      );

      const body: unknown = req.body;

      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        !("issueDescription" in body) ||
        !("ref" in body)
      ) {
        return res.status(400).json({ error: "INVALID_INVESTIGATION_INPUT" });
      }

      if (
        typeof body.issueDescription !== "string" ||
        body.issueDescription.trim().length <= 0 ||
        body.issueDescription.trim().length > 4_000
      ) {
        return res.status(400).json({ error: "INVALID_INVESTIGATION_INPUT" });
      }

      const ref = body.ref;

      if (typeof ref !== "string" || ref.trim().length === 0) {
        return res.status(400).json({ error: "INVALID_INVESTIGATION_INPUT" });
      }

      const filePaths = await listRepositoryFilePaths(owner, repo, ref);

      const rankedFiles = rankFilePaths(
        body.issueDescription.trim(),
        filePaths,
      );

      return res.status(200).json({
        owner: owner,
        repo: repo,
        ref: ref,
        candidateCount: filePaths.length,
        files: rankedFiles,
      });
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

      if (
        req.query.ref !== undefined &&
        (typeof req.query.ref !== "string" || req.query.ref.trim().length === 0)
      ) {
        return res.status(400).json({ error: "INVALID_REPOSITORY_REF" });
      }

      const response = await readRepositoryFile(
        owner,
        repo,
        req.query.path,
        req.query.ref,
      );

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

app.post(
  "/api/repositories/:owner/:repo/evidence",
  express.json({ limit: "16kb", strict: false }),
  async (req: Request, res: Response) => {
    try {
      const { owner, repo } = checkParamsValidity(
        req.params.owner,
        req.params.repo,
      );

      const body: unknown = req.body;

      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        !("issueDescription" in body) ||
        !("ref" in body)
      ) {
        return res.status(400).json({ error: "INVALID_INVESTIGATION_INPUT" });
      }

      if (
        typeof body.issueDescription !== "string" ||
        body.issueDescription.trim().length <= 0 ||
        body.issueDescription.trim().length > 4_000
      ) {
        return res.status(400).json({ error: "INVALID_INVESTIGATION_INPUT" });
      }

      const ref = body.ref;

      if (typeof ref !== "string" || ref.trim().length === 0) {
        return res.status(400).json({ error: "INVALID_INVESTIGATION_INPUT" });
      }

      const evidence = await collectRepositoryEvidence(
        owner,
        repo,
        body.issueDescription.trim(),
        ref,
      );

      return res.status(200).json(evidence);
    } catch (error) {
      if (error instanceof customError) {
        res.status(error.status).json({ error: error.message });
      } else {
        res.status(502).json({ error: "GITHUB_REQUEST_FAILED" });
      }
    }
  },
);

app.use(errorHandler);
