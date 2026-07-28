/** Built-in AI recipes — one-click prompts the cat runs (then you review the proposal). */
export interface Playbook {
  id: string
  titleKey: string
  promptKey: string
}

export const PLAYBOOKS: Playbook[] = [
  { id: 'steamPage', titleKey: 'pb.steamPage', promptKey: 'pb.steamPage.prompt' },
  { id: 'release', titleKey: 'pb.release', promptKey: 'pb.release.prompt' },
  { id: 'wishlistPush', titleKey: 'pb.wishlistPush', promptKey: 'pb.wishlistPush.prompt' },
  { id: 'influencers', titleKey: 'pb.influencers', promptKey: 'pb.influencers.prompt' },
]

/** A fresh random handful (used to surface a rotating set of suggestions). */
export function samplePlaybooks(n: number): Playbook[] {
  return [...PLAYBOOKS].sort(() => Math.random() - 0.5).slice(0, n)
}
