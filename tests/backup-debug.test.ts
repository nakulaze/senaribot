import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENARIBOT_PHONE_NUMBER = '+620000000000';
process.env.SENARIBOT_OWNER_JIDS = 'owner@s.whatsapp.net';
process.env.SENARIBOT_LOG_LEVEL = 'error';

const { createBackup } = await import('@/core/backup.js');

process.env.SENARIBOT_DB_PATH = ':memory:';
const result = createBackup();
console.log('DEBUG TEST1', JSON.stringify(result));
assert.ok(result.error?.includes('No file database'));
