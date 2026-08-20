export interface EnsembleGitHubAuthConfig {
  /** GITHUB_TOKEN / GH_TOKEN が無いとき `gh auth token` を試すか（既定: true）。 */
  allowGhAuthTokenFallback: boolean;
}

export interface EnsembleGitHubConfig {
  auth: EnsembleGitHubAuthConfig;
}

export interface EnsembleConfig {
  github: EnsembleGitHubConfig;
}
