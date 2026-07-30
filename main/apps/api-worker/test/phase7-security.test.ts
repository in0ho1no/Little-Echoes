import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { app } from '../src/app';
import type { Env } from '../src/types';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const workerRoot = join(testDirectory, '..');
const repositoryRoot = join(workerRoot, '..', '..', '..');
const recordingId = 'rec_11111111111111111111111111111111';
const diaryId = 'diary_11111111111111111111111111111111';
const wordId = 'word_11111111111111111111111111111111';

function listFiles(directory: string, extensions: string[]): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listFiles(path, extensions);
    return entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
  });
}

function inertWorkflow(): Workflow<{ async_job_id: string }> {
  return {} as Workflow<{ async_job_id: string }>;
}

function securityEnv(options: {
  accessVerify?: Env['ACCESS_JWT_VERIFY'];
  principal?: boolean;
  databaseAccess?: () => void;
  firstRow?: (sql: string) => unknown;
  allRows?: (sql: string) => unknown[];
  teamDomain?: string;
  audience?: string;
} = {}): Env {
  const database = {
    prepare: (sql: string) => {
      options.databaseAccess?.();
      return {
        bind: (..._values: unknown[]) => ({
          first: async () => {
            if (sql.includes('management_principals') && options.principal) return { household_id: 'household_1' };
            return options.firstRow?.(sql) ?? null;
          },
          all: async () => ({ results: options.allRows?.(sql) ?? [] }),
          run: async () => ({ meta: { changes: 0 } }),
        }),
      };
    },
    batch: async () => [],
  } as unknown as D1Database;
  return {
    DB: database,
    PRIVATE_MEDIA: {} as R2Bucket,
    ANALYSIS_WORKFLOW: inertWorkflow(),
    DELETE_WORKFLOW: inertWorkflow(),
    DIARY_WORKFLOW: inertWorkflow(),
    IMAGE_WORKFLOW: inertWorkflow(),
    IMAGE_CLEANUP_WORKFLOW: inertWorkflow(),
    DEVICE_TOKEN_HMAC_SECRET: 'x'.repeat(64),
    DEMO_WRITE_ENABLED: 'true',
    ACCESS_TEAM_DOMAIN: options.teamDomain ?? 'team.cloudflareaccess.com',
    ACCESS_AUD: options.audience ?? 'audience',
    ADMIN_HOST: 'app.example.test',
    INGEST_HOST: 'ingest.example.test',
    ACCESS_JWT_VERIFY: options.accessVerify,
  };
}

function accessName(node: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return null;
}

function propertyName(node: ts.PropertyName): string | null {
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : null;
}

function workflowPersistenceViolations(source: string, fileName: string): { createCalls: number; stepCalls: number; violations: string[] } {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let createCalls = 0;
  let stepCalls = 0;
  const violations: string[] = [];
  const report = (node: ts.Node, message: string): void => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push(`${fileName}:${position.line + 1}: ${message}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && accessName(node.expression) === 'create') {
      const receiver = ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)
        ? node.expression.expression
        : null;
      if (receiver && accessName(receiver) !== 'transcriptions') {
        createCalls += 1;
        const options = node.arguments[0];
        if (!options || !ts.isObjectLiteralExpression(options)) {
          report(node, 'Workflow create optionsはオブジェクトリテラルで指定すること');
        } else {
          const paramsProperties = options.properties.filter(
            (candidate): candidate is ts.PropertyAssignment =>
              ts.isPropertyAssignment(candidate) && propertyName(candidate.name) === 'params',
          );
          const params = paramsProperties[0]?.initializer;
          if (paramsProperties.length !== 1 || !params || !ts.isObjectLiteralExpression(params)) {
            report(node, 'Workflow paramsはインラインのオブジェクトリテラルで指定すること');
          } else if (
            params.properties.length !== 1
            || !ts.isPropertyAssignment(params.properties[0]!)
            || propertyName(params.properties[0]!.name) !== 'async_job_id'
          ) {
            report(node, 'Workflow paramsにはasync_job_idだけを指定すること');
          }
        }
      }
    }
    if (
      ts.isCallExpression(node)
      && accessName(node.expression) === 'do'
      && (
        (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'step')
        || (ts.isElementAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'step')
      )
    ) {
      stepCalls += 1;
      const operation = node.arguments[2];
      const body = operation && (ts.isArrowFunction(operation) || ts.isFunctionExpression(operation)) ? operation.body : null;
      const statement = body && ts.isBlock(body) && body.statements.length === 1 ? body.statements[0] : null;
      const expression = statement && ts.isExpressionStatement(statement) ? statement.expression : null;
      const awaited = expression && ts.isAwaitExpression(expression) ? expression.expression : null;
      if (
        !operation
        || !(ts.isArrowFunction(operation) || ts.isFunctionExpression(operation))
        || !operation.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
        || !awaited
        || !ts.isCallExpression(awaited)
        || !ts.isIdentifier(awaited.expression)
        || awaited.expression.text !== 'operation'
        || awaited.arguments.length !== 0
      ) {
        report(node, 'step.doはoperationをawaitするだけのasyncラッパーで戻り値を破棄すること');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { createCalls, stepCalls, violations };
}

describe('Phase 7 セキュリティ境界', () => {
  it('rejects authentication mechanism reuse across separated hosts', async () => {
    let databaseCalls = 0;
    const supplied = securityEnv({ databaseAccess: () => { databaseCalls += 1; } });
    const deviceOnAdmin = await app.fetch(
      new Request('https://app.example.test/api/v1/review-queue', {
        headers: { Authorization: `Bearer ${'a'.repeat(43)}` },
      }),
      supplied,
    );
    const accessOnIngest = await app.fetch(
      new Request(`https://ingest.example.test/api/v1/recordings/${recordingId}`, {
        headers: { 'Cf-Access-Jwt-Assertion': 'signed-access-token' },
      }),
      supplied,
    );
    expect(deviceOnAdmin.status).toBe(401);
    expect(accessOnIngest.status).toBe(401);
    expect(databaseCalls).toBe(0);
  });

  it('uses the production Access verifier fallback and fails closed before D1 for invalid issuer configuration', async () => {
    let databaseCalls = 0;
    const supplied = securityEnv({
      teamDomain: 'https://team.cloudflareaccess.com',
      databaseAccess: () => { databaseCalls += 1; },
    });
    const response = await app.fetch(
      new Request('https://app.example.test/api/v1/review-queue', {
        headers: { 'Cf-Access-Jwt-Assertion': 'signed-access-token' },
      }),
      supplied,
    );
    expect(response.status).toBe(401);
    expect(databaseCalls).toBe(0);
  });

  it('denies CORS preflight and simple cross-site mutations', async () => {
    const supplied = securityEnv({
      accessVerify: async () => ({ accessSubject: 'management-subject' }),
      principal: true,
    });
    const mutationPaths = [
      `/api/v1/recordings/${recordingId}/review`,
      `/api/v1/recordings/${recordingId}/approve`,
      `/api/v1/recordings/${recordingId}/retry-analysis`,
      `/api/v1/recordings/${recordingId}`,
      `/api/v1/diary/${diaryId}`,
      `/api/v1/diary/${diaryId}/regenerate`,
      `/api/v1/diary/${diaryId}/image`,
    ];
    for (const path of mutationPaths) {
      const preflight = await app.fetch(
        new Request(`https://app.example.test${path}`, {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://attacker.example',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type',
          },
        }),
        supplied,
      );
      expect(preflight.status).toBe(404);
      expect(preflight.headers.has('Access-Control-Allow-Origin')).toBe(false);
    }

    const postPaths = [
      `/api/v1/recordings/${recordingId}/approve`,
      `/api/v1/recordings/${recordingId}/retry-analysis`,
      `/api/v1/diary/${diaryId}/regenerate`,
      `/api/v1/diary/${diaryId}/image`,
    ];
    for (const path of postPaths) {
      for (const contentType of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data; boundary=phase7']) {
        const simpleMutation = await app.fetch(
          new Request(`https://app.example.test${path}`, {
            method: 'POST',
            headers: {
              Origin: 'https://attacker.example',
              'Cf-Access-Jwt-Assertion': 'signed-access-token',
              'Content-Type': contentType,
            },
            body: 'version=1',
          }),
          supplied,
        );
        expect(simpleMutation.status).toBe(422);
        expect(simpleMutation.headers.has('Access-Control-Allow-Origin')).toBe(false);
      }
    }
  });

  it('escapes user-controlled HTML and forbids unsafe DOM sinks', async () => {
    const maliciousName = '<svg onload=alert(1)>';
    const recording = {
      id: recordingId,
      household_id: 'household_1',
      source_id: 'source_1',
      source_type: 'pc',
      audio_sha256: '0'.repeat(64),
      audio_object_key: `recordings/${recordingId}/audio.wav`,
      analysis_status: 'ready',
      diary_status: 'ready',
      image_status: 'not_requested',
      review_status: 'pending',
      version: 1,
      captured_at: '2026-07-21T00:00:00.000Z',
      captured_timezone: 'Asia/Tokyo',
      captured_at_source: 'client_clock',
      received_at: '2026-07-21T00:00:00.000Z',
      upload_status: 'ready',
      duration_seconds: 4,
      pre_roll_seconds: 0,
      post_roll_seconds: 4,
      draft_scene: maliciousName,
      draft_parent_note: maliciousName,
    };
    const diary = {
      id: diaryId,
      household_id: 'household_1',
      recording_id: recordingId,
      diary_text: maliciousName,
      scene: maliciousName,
      version: 1,
      recording_version: 1,
      diary_status: 'ready',
      image_status: 'not_requested',
      captured_at: '2026-07-21T00:00:00.000Z',
      last_generation_error: null,
      active_image_id: null,
      active_image_created_at: null,
    };
    const supplied = securityEnv({
      accessVerify: async () => ({ accessSubject: 'management-subject' }),
      principal: true,
      firstRow: (sql) => {
        if (sql.includes('FROM recordings r JOIN sources')) return recording;
        if (sql.includes('SELECT raw_text, reviewed_text FROM transcripts')) return { raw_text: maliciousName, reviewed_text: maliciousName };
        if (sql.includes('FROM diary_entries d JOIN recordings')) return diary;
        if (sql.includes('FROM dictionary_words')) {
          return { id: wordId, display_name: maliciousName, normalized: 'test', first_spoken_at: '2026-07-21T00:00:00.000Z', occurrence_count: 1 };
        }
        return null;
      },
      allRows: (sql) => {
        if (sql.includes('FROM dictionary_words')) {
          return [{ id: wordId, display_name: maliciousName, normalized: 'test', first_spoken_at: '2026-07-21T00:00:00.000Z', occurrence_count: 1 }];
        }
        if (sql.includes('FROM word_occurrences wo JOIN recordings')) {
          return [{ recording_id: recordingId, surface: maliciousName, utterance_text: maliciousName, spoken_at: '2026-07-21T00:00:00.000Z', is_first: 1, new_override: 'auto', diary_id: diaryId }];
        }
        if (sql.includes('FROM word_candidates')) {
          return [{ surface: maliciousName, normalized: maliciousName, new_override: 'auto' }];
        }
        if (sql.includes('SELECT wo.surface')) return [{ surface: maliciousName }];
        return [];
      },
    });
    for (const path of ['/dictionary', `/dictionary/${wordId}`, `/recordings/${recordingId}`, `/diary/${diaryId}`]) {
      const response = await app.fetch(
        new Request(`https://app.example.test${path}`, {
          headers: { 'Cf-Access-Jwt-Assertion': 'signed-access-token' },
        }),
        supplied,
      );
      const responseHtml = await response.text();
      expect(response.status).toBe(200);
      expect(responseHtml).not.toContain(maliciousName);
      expect(responseHtml).toContain('&lt;svg onload=alert(1)&gt;');
    }

    const source = readFileSync(join(workerRoot, 'src', 'app.ts'), 'utf-8');
    expect(source).toContain('escapeHtml(diary.diary_text)');
    expect(source).toContain('escapeHtml(transcriptText');
    expect(source).toContain('.textContent=');
    expect(source).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/);
  });

  it('redacts unexpected exceptions and persists only opaque Workflow identifiers', async () => {
    const leakedValues = ['sensitive-api-key-value', 'parent memo value', 'recordings/rec_private/audio.wav'];
    const supplied = securityEnv({
      accessVerify: async () => {
        throw new Error(leakedValues.join(' | '));
      },
    });
    const response = await app.fetch(
      new Request('https://app.example.test/api/v1/review-queue', {
        headers: { 'Cf-Access-Jwt-Assertion': 'signed-access-token' },
      }),
      supplied,
    );
    expect(response.status).toBe(500);
    const responseText = await response.text();
    for (const value of leakedValues) expect(responseText).not.toContain(value);

    const typesSource = readFileSync(join(workerRoot, 'src', 'types.ts'), 'utf-8');
    const workflowParams = /export interface WorkflowParams\s*\{([^}]*)\}/s.exec(typesSource)?.[1] ?? '';
    expect(workflowParams.replace(/\s+/g, '')).toBe('async_job_id:string;');
    const guardResults = listFiles(join(workerRoot, 'src'), ['.ts'])
      .map((path) => workflowPersistenceViolations(readFileSync(path, 'utf-8'), path));
    expect(guardResults.reduce((total, result) => total + result.createCalls, 0)).toBe(5);
    expect(guardResults.reduce((total, result) => total + result.stepCalls, 0)).toBe(5);
    expect(guardResults.flatMap((result) => result.violations)).toEqual([]);
    const invalidBoundary = workflowPersistenceViolations(`
      const payload = { async_job_id: id, transcript: secret };
      await workflow.create({ id, params: payload });
      await step.do('unsafe', {}, async () => operation());
    `, 'invalid-workflow-boundary.ts');
    expect(invalidBoundary.violations).toHaveLength(2);
    const workflowSources = listFiles(join(workerRoot, 'src'), ['.ts']).map((path) => readFileSync(path, 'utf-8')).join('\n');
    expect(workflowSources).not.toContain('console.');
  });

  it('inventories every semgrep suppression with a reviewed rationale', () => {
    const productFiles = [
      ...listFiles(join(workerRoot, 'src'), ['.ts']),
      ...listFiles(join(repositoryRoot, 'main', 'apps', 'pc-client', 'src'), ['.py']),
    ];
    const suppressions = productFiles.flatMap((path) =>
      readFileSync(path, 'utf-8')
        .split(/\r?\n/)
        .filter((line) => line.includes('nosemgrep'))
        .map((line) => `${relative(repositoryRoot, path).replaceAll('\\', '/')}:${line.trim()}`),
    );
    expect(suppressions).toEqual([
      'main/apps/pc-client/src/client/uploader.py:# nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected',
    ]);
    const uploader = readFileSync(join(repositoryRoot, 'main', 'apps', 'pc-client', 'src', 'client', 'uploader.py'), 'utf-8');
    expect(uploader).toContain("parsed_url.scheme != 'https'");
    expect(uploader).toContain('送信直前にHTTPS・ホスト・userinfo不在を再検証するため');
  });

  it('configures redacted full-history secret scanning', () => {
    const workflow = readFileSync(join(repositoryRoot, '.github', 'workflows', 'security-scan.yml'), 'utf-8');
    const dockerfile = readFileSync(join(repositoryRoot, 'docker', 'gitleaks', 'Dockerfile'), 'utf-8');
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('detect --source . --no-banner --redact');
    expect(workflow).toContain('report-format json');
    expect(workflow).toMatch(/push:\r?\n\s+branches:\r?\n\s+- main\r?\n\s+- develop/);
    expect(workflow).toMatch(/pull_request:\r?\n\s+branches:\r?\n\s+- main\r?\n\s+- develop/);
    expect(dockerfile).toMatch(/^FROM ghcr\.io\/gitleaks\/gitleaks:v\d+\.\d+\.\d+\s*$/m);
  });
});
