export interface LatestRelease {
  tag: string
  url: string
}

export function useVersionCheck() {
  const dismiss = () => {}
  return { hasUpdate: false, latestRelease: null as LatestRelease | null, dismiss }
}
