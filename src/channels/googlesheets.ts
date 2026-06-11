/**
 * Google Sheets alert delivery: appends one row per alert to a spreadsheet.
 *
 * @module
 */

import type { Alert, AlertChannel, ChannelResult } from '../types.js';
import { type GoogleAuth, googleAccessToken } from './google-auth.js';
import { type BaseChannelOptions, channelFailure, postJson, truncate } from './shared.js';

/** OAuth2 scope required by the Sheets append endpoint. */
const SHEETS_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'] as const;

/** Options for {@link googleSheetsChannel}. */
export interface GoogleSheetsChannelOptions extends BaseChannelOptions {
  /** Target spreadsheet id. */
  spreadsheetId: string;
  /** Sheet (tab) name. Default "Sheet1". */
  sheetName?: string;
  /** Google authentication: access token source or service account. */
  auth: GoogleAuth;
}

/**
 * Creates an alert channel that appends one row per alert to a Google Sheet.
 * Row columns: ISO timestamp, agent id, severity, kind, behavior score, top
 * attribution feature (or empty), message truncated to 500 characters.
 */
export function googleSheetsChannel(options: GoogleSheetsChannelOptions): AlertChannel {
  const name = options.name ?? 'googlesheets';
  return {
    name,
    async send(alert: Alert): Promise<ChannelResult> {
      try {
        const token = await googleAccessToken(options.auth, SHEETS_SCOPES);
        const range = encodeURIComponent(`${options.sheetName ?? 'Sheet1'}!A1`);
        return await postJson({
          name,
          url: `https://sheets.googleapis.com/v4/spreadsheets/${options.spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
          body: {
            values: [
              [
                new Date(alert.timestamp).toISOString(),
                alert.agentId,
                alert.severity,
                alert.kind,
                alert.behaviorScore,
                alert.attributions[0]?.feature ?? '',
                truncate(alert.message, 500),
              ],
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
