import path from "node:path";

export function resolveRelativeImport(
  importerPath: string,
  specifier: string,
  repositoryPaths: string[],
): string | null {
  if (!repositoryPaths.includes(importerPath)) {
    return null;
  }

  if (specifier.slice(0, 2) !== "./" && specifier.slice(0, 3) !== "../") {
    return null;
  }

  if (
    specifier.includes("\\") ||
    specifier.includes("\0") ||
    specifier.includes("?") ||
    specifier.includes("#") ||
    specifier.charAt(specifier.length - 1) === "/"
  ) {
    return null;
  }

  const directory = path.posix.dirname(importerPath);

  const target = path.posix.join(directory, specifier);

  if (
    path.posix.isAbsolute(target) ||
    target === "." ||
    target === ".." ||
    target.slice(0, 3) === "../"
  ) {
    return null;
  }

  if (repositoryPaths.includes(target)) {
    return target;
  }

  if (!path.posix.extname(target)) {
    if (repositoryPaths.includes(target + ".js")) {
      return target + ".js";
    }

    if (repositoryPaths.includes(target + "/index.js")) {
      return target + "/index.js";
    }

    return null;
  }

  return null;
}
