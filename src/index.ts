export { WeiboApiClient, WeiboApiError } from './api/client.js'
export { searchAccounts, lookupAccount, extractSearchUsers, extractSearchPageUsers } from './api/search.js'
export { getAccount, fetchAllPosts, normalizePost, needsLongText } from './api/posts.js'
export type {
  AsyncTaskGate,
  FetchPostsOptions,
  FetchPostsResult,
  ProfileListingEndpoint,
  ProfileListingSource,
} from './api/posts.js'
export { AsyncSemaphore, AsyncTwoPhaseGate, mapConcurrent } from './concurrency.js'
export { exportAccount, postsToCsv } from './export.js'
export { parseAccountInput, parseAccountList } from './input.js'
export { htmlToText, decodeHtmlEntities } from './html.js'
export {
  loginWithQr,
  verifyCredential,
  saveCredential,
  loadCredential,
  clearCredential,
  extractQrScanUrl,
  cookieHeaderFromSerialized,
  CREDENTIAL_PATH,
} from './auth.js'
export type * from './types.js'
