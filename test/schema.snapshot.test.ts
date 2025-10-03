import { zReceipt } from '../receipt.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { describe, it, expect } from 'vitest';

// Keep a stable subset snapshot (exclude volatile $id)
function stable(schema: any) {
  const clone = JSON.parse(JSON.stringify(schema));
  if (clone.$id) delete clone.$id;
  return clone;
}

describe('schema snapshot', () => {
  it('Receipt JSON schema stable shape', () => {
    const schema = zodToJsonSchema(zReceipt, 'Receipt');
    expect(stable(schema)).toMatchSnapshot();
  });
});
