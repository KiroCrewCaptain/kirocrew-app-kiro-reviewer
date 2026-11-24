// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { LINE_MATCH_CAP, redactDiff, redactLine, redactText } from '../src/redact.js';

const AKID = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

describe('redactLine patterns', () => {
  const cases: Array<[string, string, string]> = [
    ['aws-access-key-id', `const id = "${AKID}";`, 'const id = "[REDACTED:aws-access-key-id]";'],
    [
      'aws-secret-access-key',
      `aws_secret_access_key = ${SECRET}`,
      'aws_secret_access_key = [REDACTED:aws-secret-access-key]',
    ],
    ['github-token', `token ghp_${'a'.repeat(36)} end`, 'token [REDACTED:github-token] end'],
    ['github-token', `x github_pat_${'B'.repeat(22)}`, 'x [REDACTED:github-token]'],
    ['slack-token', 'hook xoxb-1234567890-abcdef', 'hook [REDACTED:slack-token]'],
    ['jwt', 'auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop', 'auth [REDACTED:jwt]'],
    ['generic-secret', 'password: "hunter2hunter2"', 'password: "[REDACTED:generic-secret]"'],
    ['generic-secret', 'API_KEY=abcdef123456', 'API_KEY=[REDACTED:generic-secret]'],
  ];
  for (const [type, input, expected] of cases) {
    it(`redacts ${type} value only: ${input.slice(0, 20)}`, () => {
      const r = redactLine(input);
      expect(r.text).toBe(expected);
      expect(r.types).toContain(type);
    });
  }

  it('skips placeholders', () => {
    for (const line of [
      'password: ${DB_PASSWORD}',
      'token = <your-token-here>',
      'secret: xxxxxxxxxx',
      'pwd=********',
    ]) {
      expect(redactLine(line).types).toEqual([]);
      expect(redactLine(line).text).toBe(line);
    }
  });

  it('does not double-report an AWS key already redacted', () => {
    const r = redactLine(`access_key = ${AKID}`);
    expect(r.text).toBe('access_key = [REDACTED:aws-access-key-id]');
    expect(r.types).toEqual(['aws-access-key-id']);
  });

  it('scans lines longer than the per-match cap in chunks', () => {
    const line = 'a'.repeat(LINE_MATCH_CAP + 5) + ` ${AKID}`;
    const r = redactLine(line);
    expect(r.text.endsWith('[REDACTED:aws-access-key-id]')).toBe(true);
  });
});

describe('redactDiff', () => {
  const diff = [
    'diff --git a/src/config.ts b/src/config.ts',
    'index 1111111..2222222 100644',
    '--- a/src/config.ts',
    '+++ b/src/config.ts',
    '@@ -10,3 +10,4 @@ export const cfg = {',
    '   region: "us-west-2",',
    `-  key: "${AKID}",`,
    `+  password: "supersecretvalue",`,
    '+  other: 1,',
    '   end: true,',
    '',
  ].join('\n');

  it('keeps headers and prefixes and reports locations without values', () => {
    const r = redactDiff(diff);
    const lines = r.text.split('\n');
    expect(lines.slice(0, 5)).toEqual(diff.split('\n').slice(0, 5));
    expect(lines[6]).toBe('-  key: "[REDACTED:aws-access-key-id]",');
    expect(lines[7]).toBe('+  password: "[REDACTED:generic-secret]",');
    expect(lines[8]).toBe('+  other: 1,');
    expect(r.redactions).toEqual([
      { type: 'aws-access-key-id', file: 'src/config.ts', line: 11 },
      { type: 'generic-secret', file: 'src/config.ts', line: 11 },
    ]);
    expect(JSON.stringify(r.redactions)).not.toContain('supersecret');
    expect(r.text).not.toContain(AKID);
  });

  it('replaces a multi-line private key block, markers included', () => {
    const d = [
      'diff --git a/k.pem b/k.pem',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/k.pem',
      '@@ -0,0 +1,4 @@',
      '+-----BEGIN RSA PRIVATE KEY-----',
      '+MIIEpAIBAAKCAQEA1234',
      '+abcdefghijklmnop',
      '+-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const r = redactDiff(d);
    expect(r.text.split('\n').slice(5)).toEqual([
      '+[REDACTED:private-key]',
      '+[REDACTED:private-key]',
      '+[REDACTED:private-key]',
      '+[REDACTED:private-key]',
    ]);
    expect(r.redactions).toEqual([{ type: 'private-key', file: 'k.pem', line: 1 }]);
  });

  it('replaces a JSON-embedded single-line PEM (GCP service-account key)', () => {
    const d = [
      'diff --git a/deploy/gcp.json b/deploy/gcp.json',
      '--- /dev/null',
      '+++ b/deploy/gcp.json',
      '@@ -0,0 +1,3 @@',
      '+{',
      `+  ${GCP_LINE}`,
      '+  "client_email": "sa@p.iam.gserviceaccount.com"',
    ].join('\n');
    const r = redactDiff(d);
    expect(r.text.split('\n')[5]).toBe('+  "private_key": "[REDACTED:private-key]\\n",');
    expect(r.text).not.toContain('MIIE');
    expect(r.redactions).toEqual([{ type: 'private-key', file: 'deploy/gcp.json', line: 2 }]);
  });

  it('replaces an armored PGP private key block', () => {
    const d = [
      'diff --git a/k.asc b/k.asc',
      '--- /dev/null',
      '+++ b/k.asc',
      '@@ -0,0 +1,6 @@',
      ...PGP_BLOCK.map((l) => `+${l}`),
    ].join('\n');
    const r = redactDiff(d);
    expect(r.text.split('\n').slice(4)).toEqual(PGP_BLOCK.map(() => '+[REDACTED:private-key]'));
    expect(r.text).not.toContain('lQOYBF');
    expect(r.redactions).toEqual([{ type: 'private-key', file: 'k.asc', line: 1 }]);
  });

  it('redacts a key on a deleted line and a context line', () => {
    const d = [
      'diff --git a/a.yaml b/a.yaml',
      '--- a/a.yaml',
      '+++ b/a.yaml',
      '@@ -1,2 +1,1 @@',
      `-key: "${PEM_ONE_LINE}"`,
      ` other: "${PEM_ONE_LINE}"`,
    ].join('\n');
    const r = redactDiff(d);
    expect(r.text.split('\n').slice(4)).toEqual([
      '-key: "[REDACTED:private-key]\\n"',
      ' other: "[REDACTED:private-key]\\n"',
    ]);
    expect(r.redactions).toEqual([
      { type: 'private-key', file: 'a.yaml', line: 1 },
      { type: 'private-key', file: 'a.yaml', line: 1 },
    ]);
  });
});

const PEM_ONE_LINE = '-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----\\n';
const GCP_LINE = `"private_key": "${PEM_ONE_LINE}",`;
const PGP_BLOCK = [
  '-----BEGIN PGP PRIVATE KEY BLOCK-----',
  '',
  'lQOYBFxyz1234567890abcdefghijklmnop',
  'qrstuvwxyz0123456789ABCDEFGHIJKL',
  '=AbCd',
  '-----END PGP PRIVATE KEY BLOCK-----',
];

describe('redactText', () => {
  it('reports file line numbers', () => {
    const r = redactText(`line1\nsecret = abcdefgh12345\n`, 'docs/a.md');
    expect(r.text).toBe('line1\nsecret = [REDACTED:generic-secret]\n');
    expect(r.redactions).toEqual([{ type: 'generic-secret', file: 'docs/a.md', line: 2 }]);
  });

  it('replaces a single-line PEM and keeps text around it', () => {
    const r = redactText(`a\nx -----BEGIN EC PRIVATE KEY-----MHcCAQEE-----END EC PRIVATE KEY----- y\n`, 'k.txt');
    expect(r.text).toBe('a\nx [REDACTED:private-key] y\n');
    expect(r.redactions).toEqual([{ type: 'private-key', file: 'k.txt', line: 2 }]);
  });

  it('replaces two keys on one line and redacts other secrets between them', () => {
    const r = redactText(`${PEM_ONE_LINE} password=hunter2hunter2 ${PEM_ONE_LINE}`, 'k.txt');
    expect(r.text).toBe('[REDACTED:private-key]\\n password=[REDACTED:generic-secret] [REDACTED:private-key]\\n');
    expect(r.redactions.map((x) => x.type)).toEqual(['private-key', 'generic-secret', 'private-key']);
  });

  it('replaces the rest of the line and following lines when END is missing', () => {
    const r = redactText('k: -----BEGIN PRIVATE KEY-----MIIE\nMIIEbody\n-----END PRIVATE KEY----- tail\nnext', 'k.txt');
    expect(r.text).toBe('k: [REDACTED:private-key]\n[REDACTED:private-key]\n[REDACTED:private-key] tail\nnext');
    expect(r.redactions).toEqual([{ type: 'private-key', file: 'k.txt', line: 1 }]);
  });

  it('replaces a JSON-embedded PEM and a PGP block', () => {
    const r = redactText(`{\n  ${GCP_LINE}\n}\n${PGP_BLOCK.join('\n')}`, 'mixed.txt');
    expect(r.text).toBe(
      [
        '{',
        '  "private_key": "[REDACTED:private-key]\\n",',
        '}',
        ...PGP_BLOCK.map(() => '[REDACTED:private-key]'),
      ].join('\n'),
    );
    expect(r.redactions).toEqual([
      { type: 'private-key', file: 'mixed.txt', line: 2 },
      { type: 'private-key', file: 'mixed.txt', line: 4 },
    ]);
  });

  it('redacts a quoted private_key value without PEM markers', () => {
    const r = redactText('{"private_key": "MC4CAQAwBQYDK2VwBCIEI\\nabc"}', 'k.json');
    expect(r.text).toBe('{"private_key": "[REDACTED:private-key]"}');
    expect(r.redactions.map((x) => x.type)).toEqual(['private-key']);
  });

  it('counts nothing when no key marker or value is present', () => {
    const r = redactText('PRIVATE KEY docs: "private_key": "${KEY}"', 'docs.md');
    expect(r.redactions).toEqual([]);
  });

  it('leaves private_key assignments in ordinary code alone', () => {
    for (const line of ['privateKey: someFunctionCall(arg)', 'private_key = load_key_file(path)']) {
      const r = redactText(line, 'a.ts');
      expect(r.text).toBe(line);
      expect(r.redactions).toEqual([]);
    }
  });

  it('redacts a bare private_key value that looks like key material', () => {
    const r = redactText(`private_key: ${B64}`, 'a.yaml');
    expect(r.text).toBe('private_key: [REDACTED:private-key]');
    expect(r.redactions.map((x) => x.type)).toEqual(['private-key']);
  });

  it('redacts a key cut off before its BEGIN marker, reported once', () => {
    const r = redactText(`${B64}\n${B64}\nzz==-----END PRIVATE KEY-----\nafter`, 'k.txt');
    expect(r.text).toBe('[REDACTED:private-key]\n[REDACTED:private-key]\n[REDACTED:private-key]\nafter');
    expect(r.redactions).toEqual([{ type: 'private-key', file: 'k.txt', line: 1 }]);
  });
});

describe('cut-off and bare private keys', () => {
  it('redacts the whole bare private_key value, escapes included', () => {
    for (const [input, expected] of [
      [`private_key = "abc\\n${B64}\\nxyz"`, 'private_key = "[REDACTED:private-key]"'],
      [`private_key = 'MIIE\\n${B64}'`, "private_key = '[REDACTED:private-key]'"],
      [`PRIVATE_KEY=${B64}_url-safe`, 'PRIVATE_KEY=[REDACTED:private-key]'],
    ]) {
      const r = redactText(input, 'a.toml');
      expect(r.text).toBe(expected);
      expect(r.redactions.map((x) => x.type)).toEqual(['private-key']);
    }
  });

  it('redacts an unclosed quoted value without inventing a closing quote', () => {
    const r = redactText(`private_key = "${B64}`, 'a.toml');
    expect(r.text).toBe('private_key = [REDACTED:private-key]');
  });

  it('redacts the short last body line of a cut-off key', () => {
    const r = redactText(`${B64}\n${B64}\nabcd==\n-----END PRIVATE KEY-----\nafter`, 'k.txt');
    expect(r.text).toBe(
      '[REDACTED:private-key]\n[REDACTED:private-key]\n[REDACTED:private-key]\n[REDACTED:private-key]\nafter',
    );
    expect(r.redactions).toEqual([{ type: 'private-key', file: 'k.txt', line: 1 }]);
  });

  it('leaves hex digests, dividers and a word after other text alone', () => {
    const text = ['a'.repeat(64).replace(/a/g, 'f0'), '/'.repeat(80), '+'.repeat(70), 'word'].join('\n');
    const r = redactText(text, 'SHA256SUMS');
    expect(r.text).toBe(text);
    expect(r.redactions).toEqual([]);
  });
});

const B64 = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj';

describe('redactDiff hunks', () => {
  it('resets key state at each hunk and redacts a hunk that starts inside a key', () => {
    const d = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,1 +1,1 @@',
      '+-----BEGIN PRIVATE KEY-----',
      '@@ -50,3 +50,3 @@',
      ` ${B64}`,
      '-x',
      '+y',
    ].join('\n');
    const r = redactDiff(d);
    expect(r.text.split('\n').slice(4)).toEqual([
      '+[REDACTED:private-key]',
      '@@ -50,3 +50,3 @@',
      ' [REDACTED:private-key]',
      '-x',
      '+y',
    ]);
    expect(r.redactions).toEqual([
      { type: 'private-key', file: 'a.txt', line: 1 },
      { type: 'private-key', file: 'a.txt', line: 50 },
    ]);
  });
});
