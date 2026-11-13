import { createShareHandlers } from '../lib/shares.mjs';
export const GET = request => createShareHandlers().GET(request);
