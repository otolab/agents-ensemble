import { createRequire } from 'node:module';

/** CLI パッケージの `package.json` version（`dist/` から見て `../package.json`）。 */
export function readCliPackageVersion(
  fromModuleUrl: string | URL = import.meta.url,
): string {
  const require = createRequire(fromModuleUrl);
  const { version } = require('../package.json') as { version: string };
  return version;
}
