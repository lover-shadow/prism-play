import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../../edge/src/types/api';
import { DEFAULT_ERROR_MESSAGE, HTTP_STATUS_BY_ERROR_CODE } from '../../edge/src/http/errors';

/**
 * Drift gate for the closed error enum.
 *
 * Stage 2 shipped codes the machine-readable contract did not yet list, and separately kept an old
 * list after supervision widened it — both were only caught by hand. This test makes the enum of
 * `openapi.yaml` the thing the code is measured against, so a divergence fails the suite instead of
 * surfacing in a review report.
 */
function openApiErrorCodeEnum(): string[] {
  const yaml = readFileSync(new URL('../../docs/03-contracts/openapi.yaml', import.meta.url), 'utf8');
  const block = yaml.slice(yaml.indexOf('ErrorResponse:'));
  const enumLines: string[] = [];
  let insideEnum = false;
  for (const line of block.split('\n').slice(0, 60)) {
    if (!insideEnum) {
      insideEnum = /^\s+enum:\s*$/.test(line);
      continue;
    }
    const match = /^\s*-\s+([A-Z_]+)\s*$/.exec(line);
    if (match === null) break;
    enumLines.push(match[1] as string);
  }
  return enumLines;
}

describe('closed error enum parity with openapi.yaml', () => {
  const contractCodes = openApiErrorCodeEnum();

  it('reads a non-trivial enum out of the machine-readable source', () => {
    expect(contractCodes.length).toBeGreaterThanOrEqual(16);
  });

  it('ERROR_CODES matches the contract enum exactly, in order', () => {
    expect([...ERROR_CODES]).toEqual(contractCodes);
  });

  it('every contract code has exactly one HTTP status and one default message', () => {
    expect(Object.keys(HTTP_STATUS_BY_ERROR_CODE).sort()).toEqual([...contractCodes].sort());
    expect(Object.keys(DEFAULT_ERROR_MESSAGE).sort()).toEqual([...contractCodes].sort());
    for (const code of contractCodes) {
      const status = HTTP_STATUS_BY_ERROR_CODE[code as keyof typeof HTTP_STATUS_BY_ERROR_CODE];
      expect(Number.isInteger(status), code).toBe(true);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThanOrEqual(599);
      expect(DEFAULT_ERROR_MESSAGE[code as keyof typeof DEFAULT_ERROR_MESSAGE]).not.toBe('');
    }
  });

  it('keeps the ratified Stage 2 additions pinned to their ruled statuses', () => {
    expect(HTTP_STATUS_BY_ERROR_CODE.VALIDATION_ERROR).toBe(400);
    expect(HTTP_STATUS_BY_ERROR_CODE.PROXY_SIGNATURE_INVALID).toBe(403);
    expect(HTTP_STATUS_BY_ERROR_CODE.CATALOG_REVISION_CONFLICT).toBe(409);
    expect(HTTP_STATUS_BY_ERROR_CODE.CATALOG_CURSOR_EXPIRED).toBe(410);
    expect(HTTP_STATUS_BY_ERROR_CODE.CREDENTIAL_EXPIRED).toBe(401);
    expect(HTTP_STATUS_BY_ERROR_CODE.PLATFORM_UNSUPPORTED).toBe(400);
  });
});
