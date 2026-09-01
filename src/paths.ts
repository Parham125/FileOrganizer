// Path helpers the result views share. Both lists had their own byte-identical
// copy of each, which is how two views end up sorting the same set differently.

// The path the defaults keep: shortest first, then alphabetical so the answer
// never depends on the order the scan happened to return.
export function shortestPath(paths: string[]): string {
  return [...paths].sort(
    (a, b) => a.length - b.length || a.localeCompare(b),
  )[0];
}

export function baseName(path: string): string {
  return path.slice(
    Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1,
  );
}
