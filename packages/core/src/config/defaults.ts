import type { EnsembleConfig } from './types.js';

export const DEFAULT_ENSEMBLE_CONFIG: EnsembleConfig = {
  github: {
    auth: {
      allowGhAuthTokenFallback: true,
    },
  },
};
