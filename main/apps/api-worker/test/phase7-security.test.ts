import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { app } from '../src/app';
import type { Env } from '../src/types';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const workerRoot = join(testDirectory, '..');
const repositoryRoot = join(workerRoot, '..', '..', '..');
const recordingId = 'rec_11111111111111111111111111111111';
const diaryId = 'diary_11111111111111111111111111111111';

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
    ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
    ACCESS_AUD: 'audience',
    ADMIN_HOST: 'app.example.test',
    INGEST_HOST: 'ingest.example.test',
    ACCESS_JWT_VERIFY: options.accessVerify,
  };
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
        return null;
      },
      allRows: (sql) => {
        if (sql.includes('FROM dictionary_words')) {
          return [{ id: 'word_11111111111111111111111111111111', display_name: maliciousName, normalized: 'test', first_spoken_at: '2026-07-21T00:00:00.000Z', occurrence_count: 1 }];
        }
        if (sql.includes('FROM word_candidates')) {
          return [{ surface: maliciousName, normalized: maliciousName, new_override: 'auto' }];
        }
        if (sql.includes('SELECT wo.surface')) return [{ surface: maliciousName }];
        return [];
      },
    });
    for (const path of ['/dictionary', `/recordings/${recordingId}`, `/diary/${diaryId}`]) {
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
    const workflowSources = listFiles(join(workerRoot, 'src'), ['.ts']).map((path) => readFileSync(path, 'utf-8')).join('\n');
    const payloads = [...workflowSources.matchAll(/params:\s*\{([^}]+)\}/g)].map((match) => match[1]?.trim());
    expect(payloads.length).toBeGreaterThan(0);
    expect(payloads.every((payload) => /^async_job_id:\s*[A-Za-z0-9_.]+$/.test(payload ?? ''))).toBe(true);
    const workflowStepSources = listFiles(join(workerRoot, 'src'), ['.ts'])
      .map((path) => readFileSync(path, 'utf-8'))
      .filter((source) => source.includes('step.do('));
    expect(workflowStepSources).toHaveLength(4);
    for (const source of workflowStepSources) {
      const stepCalls = source.match(/step\.do\(/g)?.length ?? 0;
      const voidOperationSignatures = source.match(/operation:\s*\(\)\s*=>\s*Promise<void>/g)?.length ?? 0;
      expect(voidOperationSignatures).toBeGreaterThanOrEqual(stepCalls);
    }
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
    expect(dockerfile).toMatch(/^FROM ghcr\.io\/gitleaks\/gitleaks:v\d+\.\d+\.\d+\s*$/m);
  });
});
