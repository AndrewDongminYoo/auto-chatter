#!/usr/bin/env python3
"""Trusted parent runner: bound container execution, then promote allowlisted output."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import time
import uuid

BASE = Path(__file__).resolve().parent
ALLOWLIST = {'observations.json': 1024 * 1024, 'screen.png': 2 * 1024 * 1024, 'normal-desktop.png': 1024 * 1024, 'normal-mobile.png': 1024 * 1024}
TOTAL_LIMIT = 5 * 1024 * 1024


def open_directory(target):
    current = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in Path(target).parts[1:]:
            new = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=current)
            os.close(current)
            current = new
        return current
    except BaseException:
        os.close(current)
        raise


def promote(scratch_fd, artifact_fd, names):
    total = 0
    for name in names:
        if name not in ALLOWLIST or '/' in name or name in ('.', '..'):
            raise ValueError('Non-allowlisted artifact')
        source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=scratch_fd)
        try:
            before = os.fstat(source)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > ALLOWLIST[name]:
                raise ValueError('Unsafe artifact type, link count, or size')
            total += before.st_size
            if total > TOTAL_LIMIT:
                raise ValueError('Cumulative artifact limit exceeded')
            payload = bytearray()
            while len(payload) < before.st_size:
                chunk = os.read(source, min(65536, before.st_size - len(payload)))
                if not chunk:
                    raise ValueError('Artifact truncated while reading')
                payload.extend(chunk)
            if os.read(source, 1):
                raise ValueError('Artifact grew while reading')
            after = os.fstat(source)
            if (before.st_dev, before.st_ino, before.st_size, before.st_nlink, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_nlink, after.st_mtime_ns):
                raise ValueError('Artifact changed while reading')
            dest = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=artifact_fd)
            with os.fdopen(dest, 'wb') as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ValueError('Unsafe artifact destination')
                stream.write(payload)
        finally:
            os.close(source)


def capture(command, name):
    child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ, 'stdout')
    selector.register(child.stderr, selectors.EVENT_READ, 'stderr')
    output = {'stdout': bytearray(), 'stderr': bytearray()}
    deadline = time.monotonic() + 150
    try:
        while selector.get_map():
            if time.monotonic() > deadline:
                raise TimeoutError('150-second container wall limit reached')
            for key, _ in selector.select(timeout=0.25):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                output[key.data].extend(chunk)
                limit = 8 * 1024 * 1024 if key.data == 'stdout' else 1024 * 1024
                if len(output[key.data]) > limit:
                    raise ValueError('Container output limit exceeded')
        return child.wait(timeout=5), output
    finally:
        selector.close()
        if child.poll() is None:
            subprocess.run(['docker', 'kill', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            child.terminate()
            child.wait(timeout=15)
        subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--validation-root', type=Path, required=True)
    parser.add_argument('--mode', choices=['negative', 'observe', 'fixed'], required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--snapshot', choices=['candidate', 'baseline'], default='candidate')
    parser.add_argument('--audit-name', choices=['auth-response-runs'], default='auth-response-runs')
    args = parser.parse_args()
    global BASE
    BASE = args.validation_root.resolve()
    if not args.run_id.replace('_', '').isalnum():
        raise ValueError('Unsafe run ID')
    image = json.loads((BASE / 'tools' / 'toolchain.json').read_text())['image_id']
    if not image.startswith('sha256:') or len(image) != 71:
        raise ValueError('An inspected immutable image ID is required')
    output_root = BASE.parent / args.audit_name / 'agents' / args.run_id
    scratch = output_root / 'scratch'
    artifacts = output_root / 'artifacts'
    scratch.mkdir(parents=True, exist_ok=True)
    artifacts.mkdir(exist_ok=True)
    if any(scratch.iterdir()) or any(artifacts.iterdir()):
        raise ValueError('Run scratch and artifacts must be empty before execution')
    scratch_fd, artifact_fd = open_directory(scratch), open_directory(artifacts)
    name = 'ac244-' + args.run_id.replace('_', '-') + '-' + uuid.uuid4().hex[:12]
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/scratch/home', 'TMPDIR': '/scratch/tmp', 'XDG_CACHE_HOME': '/scratch/cache', 'XDG_CONFIG_HOME': '/scratch/config', 'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright', 'LANG': 'C.UTF-8'}
    command = ['docker', 'run', '--rm', '--name', name, '--network', 'none', '--read-only', '--user', '65534:65534', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--cpus', '1', '--memory', '768m', '--memory-swap', '768m', '--pids-limit', '128', '--ulimit', 'cpu=60:60', '--ulimit', 'fsize=33554432:33554432', '--ulimit', 'nofile=512:512', '--ulimit', 'core=0:0', '--ipc', 'none', '--tmpfs', '/scratch:rw,nosuid,nodev,noexec,size=256m,mode=1777']
    for folder in ['target', 'tools', 'fixture']:
        source_folder = BASE / ('baseline-target' if folder == 'target' and args.snapshot == 'baseline' else folder)
        command += ['--mount', f'type=bind,source={source_folder},target=/{folder},readonly']
    command += [image, '/usr/bin/env', '-i'] + [f'{key}={value}' for key, value in env.items()] + ['node', '/target/scripts/auth-session-acceptance.mjs', args.mode]
    source_root = BASE / ('baseline-target' if args.snapshot == 'baseline' else 'target')
    manifest = json.loads((BASE / ('baseline-source-manifest.json' if args.snapshot == 'baseline' else 'source-manifest.json')).read_text())
    for file, digest in manifest['files'].items():
        if hashlib.sha256((source_root / file).read_bytes()).hexdigest() != digest:
            raise ValueError('Source snapshot changed before execution')
    try:
        exit_code, output = capture(command, name)
        if exit_code == 0:
            observation = json.loads(output['stdout'])
            image_payloads = {}
            for key, file in [('screenshot_base64', 'screen.png'), ('desktop_base64', 'normal-desktop.png'), ('mobile_base64', 'normal-mobile.png')]:
                if key not in observation:
                    continue
                image_bytes = base64.b64decode(observation.pop(key), validate=True)
                if not image_bytes.startswith(b'\x89PNG\r\n\x1a\n'):
                    raise ValueError('Unexpected screenshot format')
                image_payloads[file] = image_bytes
        else:
            observation = {'exit_code': exit_code, 'failure': output['stderr'].decode('utf-8', errors='strict')}
            image_payloads = {}
        observation['parent_execution'] = {'command': command, 'source': manifest, 'exit_code': exit_code, 'wall_limit_seconds': 150, 'stdout_limit': 8 * 1024 * 1024, 'stderr_limit': 1024 * 1024}
        payloads = {'observations.json': json.dumps(observation, indent=2).encode() + b'\n'}
        payloads.update(image_payloads)
        for file, payload in payloads.items():
            if len(payload) > ALLOWLIST[file]:
                raise ValueError('Artifact exceeds its declared limit')
            fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=scratch_fd)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(payload)
        promote(scratch_fd, artifact_fd, payloads.keys())
        for file, digest in manifest['files'].items():
            if hashlib.sha256((source_root / file).read_bytes()).hexdigest() != digest:
                raise ValueError('Source snapshot changed during execution')
        print(json.dumps({'run_id': args.run_id, 'exit_code': exit_code, 'artifact': str(artifacts / 'observations.json'), 'stale_reproduced': observation.get('stale_reproduced'), 'before_more': observation.get('before_more'), 'after_more': observation.get('after_more'), 'failure': observation.get('failure')}))
    finally:
        os.close(scratch_fd)
        os.close(artifact_fd)


if __name__ == '__main__':
    main()
