// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkRequestPath, isDeniedPath } from '../src/safety.js';
import { rm, tempDir, write } from './helpers.js';

let top: string;
let outside: string;

beforeEach(() => {
  top = realpathSync(tempDir('kcr-safety-'));
  outside = realpathSync(tempDir('kcr-outside-'));
  write(top, 'src/users.ts', 'export {};\n');
  write(top, 'src/id_generator.ts', 'export {};\n');
  write(top, 'docs/env.md', '# env\n');
  write(top, '.git/config', '[core]\n');
  write(top, 'config/.env', 'A=1\n');
  write(outside, 'secret.txt', 'outside\n');
  write(outside, 'notes.txt', 'outside\n');
});
afterEach(() => {
  rm(top);
  rm(outside);
});

describe('isDeniedPath (SECRET_PATH_DENYLIST)', () => {
  const denied = [
    '.env',
    'config/.env',
    '.env.local',
    'app/.ENV.production',
    'certs/server.pem',
    'keys/tls.key',
    'a/b.p12',
    'a/b.pfx',
    'a/b.jks',
    'a/b.keystore',
    'a/b.ppk',
    'infra/terraform.tfstate',
    'INFRA/Terraform.TFSTATE',
    'id_rsa',
    'home/id_ed25519.pub',
    'ID_RSA',
    '.aws/config',
    'home/.ssh/known_hosts',
    'x/.gnupg/pubring.kbx',
    '.kube/config',
    '.docker/config.json',
    'x/.AWS/credentials',
    'credentials',
    'credentials.json',
    'Credentials.yml',
    '.netrc',
    '.npmrc',
    'sub/.pypirc',
    '.git-credentials',
    'secret',
    'secrets',
    'secret.yaml',
    'config/Secrets.json',
    'keys/release.asc',
    'keys/secring.gpg',
    'apple/AuthKey_ABC123.p8',
    'infra/prod.tfvars',
    '.envrc',
    'deploy/gcp-sa.json',
    'deploy/my-service-account-1234.json',
    'gcp/service_account.json',
    'gcp/sa-key.json',
    'gcp/key.json',
    'application_default_credentials.json',
    'client_secret_1234.apps.googleusercontent.com.json',
    'infra/terraform.tfstate.backup',
    'infra/prod.tfvars.json',
    'infra/x.auto.tfvars.json',
    'home/id_rsa.bak',
    'home/id_rsa.old',
    'home/id_ed25519~',
    'kubeconfig',
    'kubeconfig-prod.yaml',
    '.pgpass',
    '.htpasswd',
    '.dockercfg',
    '.boto',
    'vault/team.kdbx',
    'credentials-prod.json',
    'gcloud-key-prod.json',
    'deploy/google-creds.json',
    'kubeconfig.yaml',
    'config/secrets-prod.yaml',
    'secret_dev.yml',
    'home/.ssh.bak/known_hosts',
    'x/.aws.old/config',
    'x/.gnupg~/pubring.kbx',
  ];
  for (const p of denied) it(`denies ${p}`, () => expect(isDeniedPath(p)).toBe(true));

  const allowed = [
    'src/users.ts',
    'src/id_generator.ts',
    'docs/env.md',
    'src/environment.ts',
    'src/keyboard.ts',
    'src/secretary.ts',
    'src/credentialsHelper.ts',
    'docs/aws.md',
    'src/ssh.ts',
    'README.md',
    'src/usa.json',
    'src/monkey.json',
    'src/keymap.json',
    'src/backup.ts',
    'src/keyboard.old.ts',
    'src/kubeconfig.ts',
    'pkg/kubeconfig_loader.go',
    'regions/sa-east-1.json',
    'config/key-bindings.json',
    'i18n/translation.key.json',
  ];
  for (const p of allowed) it(`allows ${p}`, () => expect(isDeniedPath(p)).toBe(false));
});

describe('checkRequestPath', () => {
  it('accepts a normal tracked file and returns its POSIX path', () => {
    expect(checkRequestPath(top, 'src/users.ts')).toEqual({ ok: true, posix: 'src/users.ts' });
    expect(checkRequestPath(top, 'src/id_generator.ts')).toEqual({ ok: true, posix: 'src/id_generator.ts' });
    expect(checkRequestPath(top, 'docs/env.md')).toEqual({ ok: true, posix: 'docs/env.md' });
  });

  const invalid: Array<[string, string]> = [
    ['empty', ''],
    ['absolute', path.join('/etc', 'passwd')],
    ['leading slash', '/src/users.ts'],
    ['tilde', '~/notes.txt'],
    ['dot-dot segment', '../outside.txt'],
    ['inner dot-dot', 'src/../../x.ts'],
    ['backslash', 'src\\users.ts'],
    ['control character', 'src/us\u0007ers.ts'],
    ['newline', 'src/users.ts\n'],
  ];
  for (const [name, rel] of invalid) {
    it(`refuses ${name} as INVALID_PATH`, () => {
      expect(checkRequestPath(top, rel)).toEqual({ ok: false, reason: 'INVALID_PATH' });
    });
  }

  it('refuses .git/ as GIT_DIR', () => {
    expect(checkRequestPath(top, '.git/config')).toEqual({ ok: false, reason: 'GIT_DIR' });
  });

  it('refuses denylisted paths before reading them', () => {
    expect(checkRequestPath(top, 'config/.env')).toEqual({ ok: false, reason: 'DENYLISTED' });
  });

  it('refuses a symlink escaping the repository as OUTSIDE_REPO', () => {
    symlinkSync(path.join(outside, 'notes.txt'), path.join(top, 'src', 'link.ts'));
    expect(checkRequestPath(top, 'src/link.ts')).toEqual({ ok: false, reason: 'OUTSIDE_REPO' });
  });

  it('refuses a symlinked directory escaping the repository', () => {
    symlinkSync(outside, path.join(top, 'ext'));
    expect(checkRequestPath(top, 'ext/notes.txt')).toEqual({ ok: false, reason: 'OUTSIDE_REPO' });
  });

  it('checks the denylist on the resolved path too (symlink to a secret-like file)', () => {
    symlinkSync(path.join(top, 'config', '.env'), path.join(top, 'src', 'settings.ts'));
    expect(checkRequestPath(top, 'src/settings.ts')).toEqual({ ok: false, reason: 'DENYLISTED' });
  });

  it('refuses a symlink into .git/', () => {
    symlinkSync(path.join(top, '.git', 'config'), path.join(top, 'src', 'gitcfg.ts'));
    expect(checkRequestPath(top, 'src/gitcfg.ts')).toEqual({ ok: false, reason: 'GIT_DIR' });
  });

  it('reports a missing file and a directory as NOT_FOUND', () => {
    expect(checkRequestPath(top, 'src/missing.ts')).toEqual({ ok: false, reason: 'NOT_FOUND' });
    mkdirSync(path.join(top, 'empty'));
    expect(checkRequestPath(top, 'empty')).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });
});
