import {
  formatEtag,
  parseCreatePlace,
  parseIfMatch,
  parseRequestKey,
  parseSearch,
  parseUpdatePlace,
  parseUuid,
} from './contracts.js';
import { decodePageToken, encodePageToken, intentDigest } from './crypto.js';
import { invalid, precondition } from './errors.js';

function mutationResponse(result) {
  return {
    operation: result.operation,
    placeId: result.placeId,
    versionId: result.versionId,
    versionNumber: result.versionNumber,
    catalogRevision: result.catalogRevision,
    replayed: result.replayed,
  };
}

export class ProximityService {
  constructor(repository, { pageTokenSecret }) {
    if (typeof pageTokenSecret !== 'string' || Buffer.byteLength(pageTokenSecret) < 32) {
      throw new Error('pageTokenSecret must contain at least 32 bytes');
    }
    this.repository = repository;
    this.pageTokenSecret = pageTokenSecret;
  }

  async createPlace({ owner, requestKey, body }) {
    const input = parseCreatePlace(body);
    const key = parseRequestKey(requestKey);
    const digest = intentDigest({ operation: 'create', owner, input });
    const result = await this.repository.createPlace({ owner, requestKey: key, digest, input });
    return { body: mutationResponse(result), etag: formatEtag(result.versionId), created: !result.replayed };
  }

  async updatePlace({ owner, requestKey, ifMatch, placeId, body }) {
    const id = parseUuid(placeId, 'place ID');
    const baseVersionId = parseIfMatch(ifMatch);
    const input = parseUpdatePlace(body);
    const key = parseRequestKey(requestKey);
    const digest = intentDigest({ operation: 'update', owner, placeId: id, baseVersionId, input });
    const result = await this.repository.updatePlace({
      owner, requestKey: key, digest, placeId: id, baseVersionId, input,
    });
    if (result.outcome === 'precondition_failed') throw precondition(formatEtag(result.versionId));
    return { body: mutationResponse(result), etag: formatEtag(result.versionId) };
  }

  async deletePlace({ owner, requestKey, ifMatch, placeId }) {
    const id = parseUuid(placeId, 'place ID');
    const baseVersionId = parseIfMatch(ifMatch);
    const key = parseRequestKey(requestKey);
    const digest = intentDigest({ operation: 'delete', owner, placeId: id, baseVersionId });
    const result = await this.repository.deletePlace({
      owner, requestKey: key, digest, placeId: id, baseVersionId,
    });
    if (result.outcome === 'precondition_failed') throw precondition(formatEtag(result.versionId));
    return { body: mutationResponse(result), etag: formatEtag(result.versionId) };
  }

  async getPlace({ owner, placeId }) {
    const result = await this.repository.getPlace({ owner, placeId: parseUuid(placeId, 'place ID') });
    return { body: result, etag: formatEtag(result.versionId) };
  }

  #pageBody(page, owner) {
    const nextOrdinal = page.startOrdinal + page.items.length;
    const body = {
      sessionId: page.session.sessionId,
      snapshotRevision: page.session.snapshotRevision,
      resultCount: page.session.resultCount,
      expiresAt: page.session.expiresAt.toISOString(),
      items: page.items,
    };
    if (nextOrdinal < page.session.resultCount) {
      body.nextPageToken = encodePageToken({
        owner,
        session: page.session.sessionId,
        next: nextOrdinal,
      }, this.pageTokenSecret);
    }
    return body;
  }

  async createSearchSession({ owner, requestKey, body }) {
    const query = parseSearch(body);
    const key = parseRequestKey(requestKey);
    const digest = intentDigest({ operation: 'search', owner, query });
    const session = await this.repository.createSearchSession({ owner, requestKey: key, digest, query });
    const page = await this.repository.getSearchPage({ owner, sessionId: session.sessionId, startOrdinal: 0 });
    return {
      body: { ...this.#pageBody(page, owner), replayed: session.replayed },
      created: !session.replayed,
    };
  }

  async getSearchPage({ owner, sessionId, pageToken }) {
    const id = parseUuid(sessionId, 'session ID');
    const continuation = decodePageToken(pageToken, owner, this.pageTokenSecret);
    if (continuation.session !== id) {
      throw invalid('page token does not belong to this search session');
    }
    const page = await this.repository.getSearchPage({
      owner,
      sessionId: id,
      startOrdinal: continuation.next,
    });
    return { body: this.#pageBody(page, owner) };
  }
}
