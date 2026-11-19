import hashlib
import os
import pty
import select
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

node, cli = sys.argv[1:]


def read_until(fd, process, marker, timeout=15):
    output = b''
    end = time.monotonic() + timeout
    while marker not in output and time.monotonic() < end:
        if select.select([fd], [], [], 0.2)[0]:
            try:
                output += os.read(fd, 8192)
            except OSError:
                break
        if process.poll() is not None:
            break
    if marker not in output:
        raise AssertionError(f'missing {marker!r}, exit={process.poll()}, output={output!r}')
    return output


def finish(fd, process, timeout=15):
    end = time.monotonic() + timeout
    output = b''
    while process.poll() is None and time.monotonic() < end:
        if select.select([fd], [], [], 0.2)[0]:
            try:
                output += os.read(fd, 8192)
            except OSError:
                pass
    if process.poll() is None:
        raise AssertionError(f'process timed out, output={output!r}')
    return output


def start(env, args):
    master, slave = pty.openpty()
    process = subprocess.Popen([node, cli, *args], stdin=slave, stdout=slave, stderr=slave, env=env)
    os.close(slave)
    return master, process


for action in ('complete', 'cancel', 'kill'):
    with tempfile.TemporaryDirectory(prefix='ensemble-workspace-tty-') as temp:
        root = Path(temp).resolve()
        workspace = root / 'operator-agents' / 'test'
        workspace.mkdir(parents=True)
        (root / 'operator-agents.config.yaml').write_text('version: 1\ndefaultProfile: test\ncommon:\n  conductor:\n    backend: pi\n    model: smoke-model\nprofiles:\n  test: {}\n')
        digest = hashlib.sha256(str(workspace).encode()).hexdigest()
        journal = workspace.parent / f'.ensemble-workspace-move-{digest}.json'
        journal.write_text('corrupt journal')
        env = {**os.environ, 'ENSEMBLE_USER_ROOT': str(root)}
        fd, process = start(env, ['operator-workspace-maintain', '--profile', 'test'])
        try:
            read_until(fd, process, b'type COMPLETE')
            other_fd, other = start(env, ['operator-agent', '--profile', 'test', '--new'])
            try:
                output = finish(other_fd, other)
                assert other.returncode == 1 and b'Could not acquire operator workspace lock' in output, output
            finally:
                if other.poll() is None:
                    other.kill()
                    other.wait()
                os.close(other_fd)
            if action == 'kill':
                process.kill()
            else:
                os.write(fd, b'COMPLETE\n' if action == 'complete' else b'cancel\n')
            finish(fd, process)
            assert journal.exists() == (action != 'complete'), (action, journal.exists())
            if action != 'kill':
                assert process.returncode == 0, (action, process.returncode)
            if action != 'complete':
                verify_fd, verify = start(env, ['operator-workspace-maintain', '--profile', 'test'])
                try:
                    read_until(verify_fd, verify, b'type COMPLETE')
                    os.write(verify_fd, b'cancel\n')
                    finish(verify_fd, verify)
                    assert verify.returncode == 0 and journal.exists()
                finally:
                    if verify.poll() is None:
                        verify.kill()
                        verify.wait()
                    os.close(verify_fd)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            os.close(fd)
