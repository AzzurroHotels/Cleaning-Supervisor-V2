import { handleUpload } from '@vercel/blob/client';
import { validToken } from './_auth.js';

// Issues short-lived tokens so the browser can send photos and videos straight to Blob storage.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const json = await handleUpload({
      request: req,
      body: req.body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        if (!validToken(clientPayload)) throw new Error('Sign in again');
        if (!pathname.startsWith('media/')) throw new Error('Invalid upload path');
        return {
          allowedContentTypes: ['image/*', 'video/*'],
          maximumSizeInBytes: 20 * 1024 * 1024,
          addRandomSuffix: true,
        };
      },
    });
    res.status(200).json(json);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
