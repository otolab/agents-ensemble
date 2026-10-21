import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function createOrFindReleasePr({
  branchName,
  version,
  skipChangeset,
  github,
}) {
  const existingNumber = await github.findByHead(branchName);
  if (existingNumber) {
    return { action: 'found', number: String(existingNumber) };
  }

  const changes = skipChangeset
    ? '- ルートパッケージバージョンの更新のみ\n- ⚠️ changesetスキップモード'
    : '- パッケージバージョンの更新\n- CHANGELOGの自動生成';
  const checks = skipChangeset
    ? '- [ ] バージョン番号が正しいか\n- [ ] すべてのテストがパスしているか'
    : '- [ ] CHANGELOGの内容が正しいか\n- [ ] バージョン番号が正しいか\n- [ ] すべてのテストがパスしているか';
  const body = `## 🚀 Release v${version}

このPRはrelease/${version}ブランチからの自動生成です。

### 変更内容
${changes}

### マージ後の動作
- mainブランチへのマージ時に自動的にnpmへ公開されます

### 確認事項
${checks}`;

  await github.create({
    base: 'main',
    head: branchName,
    title: `Release v${version}`,
    body,
  });
  return { action: 'created' };
}

function githubCli() {
  return {
    findByHead(branchName) {
      const number = execFileSync(
        'gh',
        ['pr', 'list', '--head', branchName, '--json', 'number', '-q', '.[0].number'],
        { encoding: 'utf8' },
      ).trim();
      return number || undefined;
    },
    create({ base, head, title, body }) {
      execFileSync(
        'gh',
        ['pr', 'create', '--base', base, '--head', head, '--title', title, '--body', body],
        { stdio: 'inherit' },
      );
    },
  };
}

async function main() {
  const [branchName, version, skipChangesetArg] = process.argv.slice(2);
  if (!branchName || !version || !skipChangesetArg) {
    throw new Error('Expected branch name, version, and skipChangeset arguments');
  }

  const result = await createOrFindReleasePr({
    branchName,
    version,
    skipChangeset: skipChangesetArg === 'true',
    github: githubCli(),
  });

  if (result.action === 'found') {
    console.log(`PR #${result.number} already exists for ${branchName}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
