// "Was this module run directly?" — robust to symlinked entry points and to
// paths with spaces or non-ASCII characters, both of which break the naive
// `import.meta.url === \`file://${process.argv[1]}\`` comparison (import.meta.url
// is percent-encoded and symlink-resolved; argv[1] is neither). A CLI that
// silently does nothing is worse than one that fails.
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function isMainModule(metaUrl) {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return metaUrl === pathToFileURL(realpathSync(entry)).href
  } catch {
    return false
  }
}
