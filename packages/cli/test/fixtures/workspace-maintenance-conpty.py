"""Exercise the built CLI through Windows ConPTY, including a competing instance."""
import hashlib
import os
import select
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from winpty import PtyProcess
from winpty.enums import Backend

node, cli = sys.argv[1:]


def start(env, args):
    return PtyProcess.spawn([node, *args], env=env, dimensions=(40, 160), backend=Backend.ConPTY)


def read_until(process, marker, timeout=30):
    output = ''
    deadline = time.monotonic() + timeout
    while marker not in output and time.monotonic() < deadline:
        if select.select([process.fileobj], [], [], 0.1)[0]:
            try:
                output += process.read(8192)
            except EOFError:
                break
        elif not process.isalive():
            break
    if marker not in output:
        raise AssertionError(f'missing {marker!r}, output={output!r}')
    return output


def finish(process, timeout=30):
    output = ''
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if select.select([process.fileobj], [], [], 0.1)[0]:
            try:
                output += process.read(8192)
            except EOFError:
                break
        elif not process.isalive():
            break
    if process.isalive():
        raise AssertionError(f'process timed out, output={output!r}')
    return process.exitstatus, output


def cleanup(process):
    if process.isalive():
        os.kill(process.pid, signal.SIGTERM)
        finish(process)
    process.close(force=True)


probe = start(os.environ.copy(), ['-e',
    'console.log("CONPTY_IS_TTY=" + Boolean(process.stdin.isTTY && process.stdout.isTTY))'])
try:
    read_until(probe, 'CONPTY_IS_TTY=true')
    code, _ = finish(probe)
    assert code == 0, code
finally:
    cleanup(probe)

for action in ('complete', 'cancel', 'kill'):
    with tempfile.TemporaryDirectory(prefix='ensemble-workspace-conpty-') as temp:
        root = Path(temp).resolve()
        workspace = root / 'operator-agents' / 'test'
        workspace.mkdir(parents=True)
        (root / 'operator-agents.config.yaml').write_text(
            'version: 1\ndefaultProfile: test\ncommon:\n  conductor:\n'
            '    backend: pi\n    model: smoke-model\nprofiles:\n  test: {}\n',
            encoding='utf-8',
        )
        canonical = subprocess.check_output(
            [node, '-e', 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))', str(workspace)],
            encoding='utf-8',
        )
        digest = hashlib.sha256(canonical.encode('utf-8')).hexdigest()
        journal = workspace.parent / f'.ensemble-workspace-move-{digest}.json'
        journal.write_text('corrupt journal', encoding='utf-8')
        env = {**os.environ, 'ENSEMBLE_USER_ROOT': str(root)}
        process = start(env, [cli, 'operator-workspace-maintain', '--profile', 'test'])
        try:
            read_until(process, 'type COMPLETE')
            other = start(env, [cli, 'operator-agent', '--profile', 'test', '--new'])
            try:
                code, output = finish(other)
                assert code == 1 and 'Could not acquire operator workspace lock' in output, (code, output)
            finally:
                cleanup(other)
            if action == 'kill':
                os.kill(process.pid, signal.SIGTERM)
            else:
                process.write('COMPLETE\r\n' if action == 'complete' else 'cancel\r\n')
            code, output = finish(process)
            assert journal.exists() == (action != 'complete'), (action, output)
            if action != 'kill':
                assert code == 0, (action, code, output)
            if action != 'complete':
                verify = start(env, [cli, 'operator-workspace-maintain', '--profile', 'test'])
                try:
                    read_until(verify, 'type COMPLETE')
                    verify.write('cancel\r\n')
                    code, output = finish(verify)
                    assert code == 0 and journal.exists(), (code, output)
                finally:
                    cleanup(verify)
        finally:
            cleanup(process)
    print(f'ConPTY {action}: ok', flush=True)
