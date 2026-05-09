# Derives per-install image base name from the project root path.
# Matches src/install-slug.ts: sha1(projectRoot)[:8].
container_image_base() {
  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  local slug
  slug="$(echo -n "$root" | sha1sum | cut -c1-8)"
  echo "nanoclaw-agent-v2-${slug}"
}
