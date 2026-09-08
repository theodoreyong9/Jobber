// agent.js — the actual meta-agent logic, kept pure and separate from its
// UI (agent-ui.js) so it's directly unit-testable.
//
// What this looks for: among everyone you've already discovered (in any
// namespace), does anyone need something you offer (in any of your other
// identities), or offer something you're looking for? That's a real cross-
// namespace opportunity a same-namespace matching pass would never
// surface — you were discovered as a Business contact, but what they need
// happens to match what you offer as an Independant, say.
//
// Every finding records whether it depended on AI-enriched keywords or
// would have shown up from CPU keywords alone — the same CPU/AI
// transparency the rest of the app already keeps (chip counts, "AI
// enriched" badges), applied here instead of hidden inside a score.

import { NS_CONFIG } from './state.js';
import { matchTokens } from './matching.js';

// Classifies any profile-shaped or discovery-payload-shaped object (both
// carry the same field names: tokens, aiTokens, and searchTokens for
// reciprocal namespaces) into what it offers vs what it's searching for.
// Two-sided namespaces only ever declare one side of that per identity —
// the supply role's tokens are an offer, the demand role's tokens are a
// search, never both — reciprocal (Dating) declares both explicitly.
export function extractOfferSearch(ns, role, data) {
  const cfg = NS_CONFIG[ns];
  const tokens = data.tokens || [];
  const aiTokens = data.aiTokens || [];
  if (!cfg) return { offerTokens: [], offerTokensAi: [], searchTokens: [], searchTokensAi: [] };

  if (cfg.kind === 'twoSided') {
    const isSupply = role === cfg.roles[0].key;
    return isSupply
      ? { offerTokens: tokens, offerTokensAi: aiTokens, searchTokens: [], searchTokensAi: [] }
      : { offerTokens: [], offerTokensAi: [], searchTokens: tokens, searchTokensAi: aiTokens };
  }
  if (cfg.kind === 'reciprocal') {
    return { offerTokens: tokens, offerTokensAi: aiTokens, searchTokens: data.searchTokens || [], searchTokensAi: [] };
  }
  return { offerTokens: [], offerTokensAi: [], searchTokens: [], searchTokensAi: [] };
}

function crossCheck(offerSide, searchSide) {
  const cpu = matchTokens(offerSide.tokens, searchSide.tokens);
  const withAi = matchTokens(
    [...offerSide.tokens, ...offerSide.tokensAi],
    [...searchSide.tokens, ...searchSide.tokensAi]
  );
  if (withAi.score === 0) return null;
  return {
    score: withAi.score,
    matchedKeywords: withAi.matchedKeywords,
    // True the moment AI-derived keywords on *either* side were actually
    // needed to reach this score — a match CPU tokens alone already found
    // is flagged false even if AI tokens exist, since they weren't what
    // revealed it.
    usedAi: withAi.score > cpu.score || (cpu.score === 0 && withAi.score > 0),
  };
}

// `mine` / `peers` are lists of { ns, identityId | sender, role,
// offerTokens, offerTokensAi, searchTokens, searchTokensAi }, produced by
// mapping extractOfferSearch over your own identities and over discovered
// peers respectively. Returns every revelation above zero score, ranked.
export function findOpportunities(mine, peers) {
  const results = [];
  for (const m of mine) {
    for (const p of peers) {
      if (m.offerTokens.length && p.searchTokens.length) {
        const hit = crossCheck(
          { tokens: m.offerTokens, tokensAi: m.offerTokensAi },
          { tokens: p.searchTokens, tokensAi: p.searchTokensAi }
        );
        if (hit) {
          results.push({
            direction: 'i-offer-they-search',
            myNs: m.ns, myIdentityId: m.identityId,
            theirNs: p.ns, theirSender: p.sender, theirRole: p.role,
            ...hit,
          });
        }
      }
      if (m.searchTokens.length && p.offerTokens.length) {
        const hit = crossCheck(
          { tokens: p.offerTokens, tokensAi: p.offerTokensAi },
          { tokens: m.searchTokens, tokensAi: m.searchTokensAi }
        );
        if (hit) {
          results.push({
            direction: 'i-search-they-offer',
            myNs: m.ns, myIdentityId: m.identityId,
            theirNs: p.ns, theirSender: p.sender, theirRole: p.role,
            ...hit,
          });
        }
      }
    }
  }
  return results.sort((a, b) => b.score - a.score);
}
