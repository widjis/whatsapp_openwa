"""Exercise deployment decisions with a fake Docker CLI; never start containers."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
FAKE = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with open(os.environ['DOCKER_CALLS'], 'a') as f: f.write(json.dumps(args)+'\n')
if args[:2] == ['compose', 'version']: sys.exit(0)
if args[:1] == ['info']: sys.exit(0)
if args[:1] == ['inspect']:
 print(os.environ.get('FAKE_STATE','running healthy')); sys.exit(0)
if 'config' in args:
 if '--services' in args:
  if any('multi.yml' in a for a in args): print('whatsapp-openwa-8192\nwhatsapp-openwa-8193')
  else: print('whatsapp-openwa')
 sys.exit(0)
if 'build' in args: sys.exit(int(os.environ.get('BUILD_EXIT','0')))
if 'ps' in args and '-q' in args: print('container-test')
'''

class DeployTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'project with spaces'
        (self.root / 'scripts').mkdir(parents=True)
        shutil.copy2(ROOT / 'scripts/docker-deploy.sh', self.root / 'scripts/docker-deploy.sh')
        for filename in ['docker-compose.yml', 'docker-compose.multi.yml']:
            shutil.copy2(ROOT / filename, self.root / filename)
        (self.root / '.env').write_text('SECRET=do-not-print\n')
        binary = Path(self.tmp.name) / 'bin'
        binary.mkdir()
        (binary / 'docker').write_text(FAKE)
        (binary / 'docker').chmod(0o755)
        self.calls = Path(self.tmp.name) / 'calls'
        self.env = {**os.environ, 'PATH': str(binary)+os.pathsep+os.environ['PATH'], 'DOCKER_CALLS': str(self.calls)}

    def tearDown(self):
        self.tmp.cleanup()

    def run_script(self, *args, **env):
        return subprocess.run(['/bin/bash', str(self.root / 'scripts/docker-deploy.sh'), *args], cwd='/tmp', env={**self.env, **env}, text=True, capture_output=True, timeout=10)

    def history(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def test_help_without_env_or_docker(self):
        (self.root / '.env').unlink()
        result = self.run_script('help')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.history(), [])

    def test_deploy_builds_before_recreate_then_checks_health(self):
        result = self.run_script('deploy')
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.history()
        build = next(i for i, x in enumerate(commands) if 'build' in x)
        up = next(i for i, x in enumerate(commands) if 'up' in x)
        health = next(i for i, x in enumerate(commands) if 'inspect' in x)
        self.assertLess(build, up)
        self.assertLess(up, health)
        self.assertIn('--force-recreate', commands[up])
        self.assertNotIn('down', sum(commands, []))
        self.assertTrue((self.root / 'data').is_dir())

    def test_failed_build_does_not_touch_running_service(self):
        result = self.run_script('deploy', BUILD_EXIT='23')
        self.assertEqual(result.returncode, 23)
        self.assertFalse(any('up' in x or 'down' in x for x in self.history()))

    def test_one_multi_service_only(self):
        result = self.run_script('deploy', '--multi', '--service', 'whatsapp-openwa-8192', '--no-build')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any('build' in x for x in self.history()))
        self.assertFalse((self.root / 'data-8193').exists())
        self.assertTrue((self.root / 'data-8192').is_dir())
        self.assertTrue(all(x[-1] == 'whatsapp-openwa-8192' for x in self.history() if 'up' in x))

    def test_invalid_service_and_scoped_down_rejected(self):
        self.assertNotEqual(self.run_script('deploy', '--service', 'typo').returncode, 0)
        self.assertNotEqual(self.run_script('down', '--service', 'whatsapp-openwa').returncode, 0)
        self.assertFalse(any('up' in x or 'down' in x for x in self.history()))

    def test_check_is_quiet_and_does_not_require_daemon(self):
        result = self.run_script('config')
        self.assertEqual(result.returncode, 0)
        self.assertNotIn('do-not-print', result.stdout+result.stderr)
        self.assertFalse(any('info' in x for x in self.history()))
        self.assertTrue(any('config' in x and '--quiet' in x for x in self.history()))

    def test_missing_healthcheck_and_timeout_fail(self):
        result = self.run_script('health', FAKE_STATE='running missing')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('no healthcheck', result.stderr)
        result = self.run_script('health', '--timeout', '1', FAKE_STATE='running unhealthy')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('timed out', result.stderr)

    def test_invalid_options_fail_before_docker(self):
        for args in [('deploy', '--no-build', '--no-cache'), ('health', '--timeout', '0'), ('build', '--no-build'), ('unknown',)]:
            self.assertNotEqual(self.run_script(*args).returncode, 0)
        self.assertEqual(self.history(), [])

    def test_no_cache_and_logs_flags(self):
        self.assertEqual(self.run_script('build', '--no-cache').returncode, 0)
        self.assertTrue(any('build' in x and '--no-cache' in x for x in self.history()))
        self.assertEqual(self.run_script('logs', '--no-follow').returncode, 0)
        log = next(x for x in self.history() if 'logs' in x)
        self.assertNotIn('-f', log[log.index('logs'):])

if __name__ == '__main__':
    unittest.main()
