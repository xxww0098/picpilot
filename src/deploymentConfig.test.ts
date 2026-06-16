import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

function readRepoFile(path: string): string {
  return readFileSync(path, 'utf8')
}

function section(text: string, start: RegExp, end: RegExp): string {
  const startMatch = start.exec(text)
  expect(startMatch, `missing section ${start}`).toBeTruthy()
  if (!startMatch) {
    throw new Error(`missing section ${start}`)
  }
  const from = startMatch.index
  const rest = text.slice(from + startMatch[0].length)
  const endMatch = end.exec(rest)
  return endMatch ? text.slice(from, from + startMatch[0].length + endMatch.index) : text.slice(from)
}

describe('production deployment wiring', () => {
  it('starts the in-stack cliproxy service before auth can resolve API upstreams', () => {
    const compose = readRepoFile('deploy/vps/compose.yml')
    const authSection = section(compose, /^  auth:\n/m, /^  [a-z][\w-]*:\n/m)

    expect(authSection).toMatch(/depends_on:\n\s+- cliproxy\b/)
    expect(authSection).toContain('API_PROXY_URL=${API_PROXY_URL:-http://cliproxy:8317/v1}')
    expect(authSection).toContain('CLIPROXY_API_URL=${CLIPROXY_API_URL:-http://cliproxy:8317}')
  })

  it('brings up cliproxy with auth during VPS releases', () => {
    const deployScript = readRepoFile('deploy/deploy.sh')

    expect(deployScript).toMatch(/docker compose up -d[^\n]*\bcliproxy\b[^\n]*\bauth\b/)
  })

  it('updates the production cliproxy service instead of creating a separate local CPA stack', () => {
    const updateScript = readRepoFile('deploy/update-cliproxy.sh')

    expect(updateScript).toContain('/opt/picpilot')
    expect(updateScript).toMatch(/SERVICE="cliproxy"/)
    expect(updateScript).not.toMatch(/SERVICE="cli-proxy-api"/)
  })
})
