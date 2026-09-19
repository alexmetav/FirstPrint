import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../supabase/migrations/202609190001_points_beta.sql', import.meta.url), 'utf8');

test('Supabase beta migration protects point-changing tables behind RPCs and RLS', () => {
  for (const table of ['fp_profiles', 'fp_ledger', 'fp_markets', 'fp_predictions']) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
  }
  assert.match(sql, /security definer[\s\S]*set search_path = ''/i);
  assert.match(sql, /points = points - p_stake[\s\S]*points >= p_stake/i);
  assert.match(sql, /unique \(user_id, request_id\)/i);
  assert.match(sql, /revoke all on public\.fp_profiles[\s\S]*from anon, authenticated/i);
  assert.doesNotMatch(sql, /grant (insert|update|delete).*authenticated/i);
});
