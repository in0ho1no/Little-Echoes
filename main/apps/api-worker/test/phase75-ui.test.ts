import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

interface OpenApiDocument {
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string }> }>>;
  components: {
    schemas: Record<string, {
      required?: string[];
      properties?: Record<string, { $ref?: string }>;
    }>;
  };
}

describe('Phase 7.5 UI契約', () => {
  it('日記詳細の成功応答はgeneration_usageを必須にする', () => {
    const path = fileURLToPath(new URL('../../../packages/shared/api/openapi.json', import.meta.url));
    const document = JSON.parse(readFileSync(path, 'utf-8')) as OpenApiDocument;
    const diaryPath = document.paths['/api/v1/diary/{diary_id}'];

    expect(diaryPath.get.responses['200'].$ref).toBe('#/components/responses/DiaryDetail');
    expect(diaryPath.patch.responses['200'].$ref).toBe('#/components/responses/DiaryDetail');
    expect(document.components.schemas.DiaryDetail.required).toContain('generation_usage');
    expect(document.components.schemas.DiaryDetail.properties?.generation_usage?.$ref).toBe('#/components/schemas/GenerationUsage');
    expect(document.components.schemas.GenerationUsage.required).toEqual([
      'text_daily',
      'image_daily',
      'image_recording',
      'manual_diary_regeneration_used',
    ]);
    expect(document.components.schemas.GenerationUsageCounter.required).toEqual(['used', 'limit', 'remaining']);
  });
});
