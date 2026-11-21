import { createShareHandlers } from '../lib/shares.mjs';
export const POST = request => createShareHandlers().POST(request);
export const DELETE = request => createShareHandlers().DELETE(request);
