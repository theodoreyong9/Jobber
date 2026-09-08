import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractOfferSearch, findOpportunities } from '../js/agent.js';

/* ---- extractOfferSearch: who's offering, who's searching ---- */

test('extractOfferSearch: the supply role in a two-sided namespace is an offer, not a search', () => {
  const r = extractOfferSearch('employment', 'candidate', { tokens: ['python', 'django'], aiTokens: ['backend'] });
  assert.deepEqual(r.offerTokens, ['python', 'django']);
  assert.deepEqual(r.offerTokensAi, ['backend']);
  assert.deepEqual(r.searchTokens, []);
});

test('extractOfferSearch: the demand role in a two-sided namespace is a search, not an offer', () => {
  const r = extractOfferSearch('employment', 'recruiter', { tokens: ['python', 'django'], aiTokens: ['backend'] });
  assert.deepEqual(r.searchTokens, ['python', 'django']);
  assert.deepEqual(r.searchTokensAi, ['backend']);
  assert.deepEqual(r.offerTokens, []);
});

test('extractOfferSearch: reciprocal (Dating) declares both an offer and a search at once', () => {
  const r = extractOfferSearch('dating', 'anything', { tokens: ['hiking'], aiTokens: [], searchTokens: ['climbing'] });
  assert.deepEqual(r.offerTokens, ['hiking']);
  assert.deepEqual(r.searchTokens, ['climbing']);
});

test('extractOfferSearch: research/agent/near namespaces contribute nothing', () => {
  const r = extractOfferSearch('research', null, { tokens: ['whatever'] });
  assert.deepEqual(r, { offerTokens: [], offerTokensAi: [], searchTokens: [], searchTokensAi: [] });
});

/* ---- findOpportunities: cross-namespace revelations ---- */

test('findOpportunities finds a match when I offer what a discovered peer searches for', () => {
  const mine = [{ ns: 'independant', identityId: 'ME1', offerTokens: ['plumbing', 'repair'], offerTokensAi: [], searchTokens: [], searchTokensAi: [] }];
  const peers = [{ ns: 'business', sender: 'PEER1', role: 'client', offerTokens: [], offerTokensAi: [], searchTokens: ['plumbing'], searchTokensAi: [] }];
  const results = findOpportunities(mine, peers);
  assert.equal(results.length, 1);
  assert.equal(results[0].direction, 'i-offer-they-search');
  assert.equal(results[0].theirNs, 'business');
  assert.ok(results[0].score > 0);
});

test('findOpportunities finds a match when a discovered peer offers what I search for', () => {
  const mine = [{ ns: 'employment', identityId: 'ME1', offerTokens: [], offerTokensAi: [], searchTokens: ['python', 'django'], searchTokensAi: [] }];
  const peers = [{ ns: 'annonce', sender: 'PEER1', role: 'seller', offerTokens: ['python'], offerTokensAi: [], searchTokens: [], searchTokensAi: [] }];
  const results = findOpportunities(mine, peers);
  assert.equal(results.length, 1);
  assert.equal(results[0].direction, 'i-search-they-offer');
});

test('findOpportunities finds nothing when there is no token overlap at all', () => {
  const mine = [{ ns: 'independant', identityId: 'ME1', offerTokens: ['plumbing'], offerTokensAi: [], searchTokens: [], searchTokensAi: [] }];
  const peers = [{ ns: 'business', sender: 'PEER1', role: 'client', offerTokens: [], offerTokensAi: [], searchTokens: ['catering'], searchTokensAi: [] }];
  assert.deepEqual(findOpportunities(mine, peers), []);
});

test('findOpportunities marks usedAi:false when the CPU-only tokens already produce the match', () => {
  const mine = [{ ns: 'independant', identityId: 'ME1', offerTokens: ['plumbing'], offerTokensAi: ['irrelevant'], searchTokens: [], searchTokensAi: [] }];
  const peers = [{ ns: 'business', sender: 'PEER1', role: 'client', offerTokens: [], offerTokensAi: [], searchTokens: ['plumbing'], searchTokensAi: [] }];
  const [hit] = findOpportunities(mine, peers);
  assert.equal(hit.usedAi, false);
});

test('findOpportunities marks usedAi:true when only the AI-enriched tokens create the overlap', () => {
  const mine = [{ ns: 'independant', identityId: 'ME1', offerTokens: ['pipefitting'], offerTokensAi: ['plumbing'], searchTokens: [], searchTokensAi: [] }];
  const peers = [{ ns: 'business', sender: 'PEER1', role: 'client', offerTokens: [], offerTokensAi: [], searchTokens: ['plumbing'], searchTokensAi: [] }];
  const [hit] = findOpportunities(mine, peers);
  assert.equal(hit.usedAi, true);
});

test('findOpportunities ranks results by score, highest first', () => {
  const mine = [{ ns: 'independant', identityId: 'ME1', offerTokens: ['plumbing', 'repair', 'heating'], offerTokensAi: [], searchTokens: [], searchTokensAi: [] }];
  const peers = [
    { ns: 'business', sender: 'WEAK', role: 'client', offerTokens: [], offerTokensAi: [], searchTokens: ['plumbing', 'unrelated1', 'unrelated2', 'unrelated3'], searchTokensAi: [] },
    { ns: 'annonce', sender: 'STRONG', role: 'buyer', offerTokens: [], offerTokensAi: [], searchTokens: ['plumbing', 'repair', 'heating'], searchTokensAi: [] },
  ];
  const results = findOpportunities(mine, peers);
  assert.equal(results[0].theirSender, 'STRONG');
});
