export type SSHAuthorizationOutcome = {
  stage: 'banner' | 'authentication-failed' | 'timeout' | 'connection-failed' | 'session-opened';
  bannerSeen: boolean;
  hasLoginURL: boolean;
};

export function assertSSHAuthorizationOutcome(outcome: SSHAuthorizationOutcome): void {
  if (outcome.stage === 'session-opened') return;
  if (outcome.stage === 'banner' && outcome.bannerSeen && outcome.hasLoginURL) return;

  const category = outcome.stage === 'banner'
    ? outcome.bannerSeen ? 'authorization-url-missing' : 'authorization-banner-missing'
    : outcome.stage === 'authentication-failed' ? 'authentication-rejected' : outcome.stage;
  throw new Error(`caeast1 SSH probe failed at second-auth (category: ${category})`);
}
