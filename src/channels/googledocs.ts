/**
 * Google Docs alert delivery: appends the alert text to a document.
 *
 * @module
 */

import type { Alert, AlertChannel, ChannelResult } from '../types.js';
import { type GoogleAuth, googleAccessToken } from './google-auth.js';
import { alertText, type BaseChannelOptions, channelFailure, postJson } from './shared.js';

/** OAuth2 scope required by the Docs batchUpdate endpoint. */
const DOCS_SCOPES = ['https://www.googleapis.com/auth/documents'] as const;

/** Options for {@link googleDocsChannel}. */
export interface GoogleDocsChannelOptions extends BaseChannelOptions {
  /** Target document id. */
  documentId: string;
  /** Google authentication: access token source or service account. */
  auth: GoogleAuth;
}

/**
 * Creates an alert channel that appends the plain-text alert rendering to the
 * end of a Google Doc via a batchUpdate insertText request.
 */
export function googleDocsChannel(options: GoogleDocsChannelOptions): AlertChannel {
  const name = options.name ?? 'googledocs';
  return {
    name,
    async send(alert: Alert): Promise<ChannelResult> {
      try {
        const token = await googleAccessToken(options.auth, DOCS_SCOPES);
        return await postJson({
          name,
          url: `https://docs.googleapis.com/v1/documents/${options.documentId}:batchUpdate`,
          body: {
            requests: [
              {
                insertText: {
                  endOfSegmentLocation: { segmentId: '' },
                  text: `\n${alertText(alert)}\n`,
                },
              },
            ],
          },
          headers: { Authorization: `Bearer ${token}` },
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        });
      } catch (error) {
        return channelFailure(name, error);
      }
    },
  };
}
