// import dotenv from 'dotenv';
import path from 'path';
import * as AWS from 'aws-sdk';
import { createAdminApiClient } from '@builder.io/admin-sdk';

// dotenv.config();

if (!process.env.BUILDER_PRIVATE_KEY) {
  throw new Error('BUILDER_PRIVATE_KEY must be set');
}

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set');
}

if (!process.env.AWS_BUCKET_NAME) {
  throw new Error('AWS_BUCKET_NAME must be set');
}

const adminSDK = createAdminApiClient(process.env.BUILDER_PRIVATE_KEY);

const publicDomain = 'https://d1ttqs35fxgawv.cloudfront.net/builder';

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

function isS3NotFound(err: unknown): boolean {
  const e = err as { code?: string; statusCode?: number; name?: string };
  return (
    e.code === 'NotFound' ||
    e.code === 'NoSuchKey' ||
    e.name === 'NotFound' ||
    e.statusCode === 404
  );
}

function safeDecodePath(p: string): string {
  if (!p) return p;
  try {
    const decoded = decodeURIComponent(p);
    if (decoded.includes('%')) {
      return decodeURIComponent(decoded);
    }
    return decoded;
  } catch {
    return p;
  }
}

function sanitizeFilename(filename: string): string {
  if (!filename) return 'asset';
  return filename
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/__+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 255);
}

/** Mirrors push-to-env.ts — maps Builder / HTTP mime types to file suffixes */
function getFileExtension(mimeType: string): string {
  const mimeTypeMap: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'image/xml': 'xml',
    'image/webp': 'webp',
    'image/tiff': 'tiff',
    'image/bmp': 'bmp',
    'image/vnd.microsoft.icon': 'ico',
    'image/vnd.adobe.photoshop': 'psd',
    'image/x-icon': 'ico',
    'image/x-photoshop': 'psd',
    'image/x-tiff': 'tiff',
    'image/x-windows-bmp': 'bmp',
    'image/x-xbitmap': 'xbm',
    'image/x-xbm': 'xbm',
    'image/x-xpixmap': 'xpm',
    'image/xpm': 'xpm',
    'image/x-xpm': 'xpm',
    'image/x-xwd': 'xwd',
    'image/x-xwindowdump': 'xwd',
    'image/xwd': 'xwd',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'font/woff': 'woff',
    'font/woff2': 'woff2',
    'application/font-woff': 'woff',
    'application/font-woff2': 'woff2',
  };
  const normalized = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return mimeTypeMap[normalized] ?? '';
}

function normalizeContentType(
  assetType: string | undefined | null,
  headerType: string | null,
): string {
  const fromAsset = assetType?.split(';')[0]?.trim();
  if (fromAsset) return fromAsset;
  const fromHeader = headerType?.split(';')[0]?.trim();
  if (fromHeader) return fromHeader;
  return 'application/octet-stream';
}

type S3KeyParts = {
  s3Key: string;
  s3RelativeKey: string;
  contentType: string;
  ext: string;
};

function computeS3KeyParts(
  asset: AssetRow,
  urlObj: URL,
  headerContentType: string | null,
): S3KeyParts {
  const fullPath = urlObj.pathname;
  const decodedPath = safeDecodePath(fullPath);
  const noSlashFullPath = decodedPath.replace(/^\/+/, '');

  const contentType = normalizeContentType(asset.type, headerContentType);
  let ext = getFileExtension(contentType);

  if (!ext && headerContentType) {
    ext = getFileExtension(headerContentType);
  }

  if (!ext) {
    const last = path.posix.basename(noSlashFullPath);
    const dot = last.lastIndexOf('.');
    if (dot > 0) {
      ext = last.slice(dot + 1).toLowerCase();
    }
  }

  const dir = path.posix.dirname(noSlashFullPath);
  const fileBase = path.posix.basename(noSlashFullPath);
  const baseWithoutExt = fileBase.includes('.')
    ? fileBase.replace(/\.[^.]+$/, '')
    : fileBase;
  const safeBase = sanitizeFilename(baseWithoutExt || asset.id);
  const relative =
    dir === '.' || dir === '' ? safeBase : `${dir}/${safeBase}`;

  const suffix = ext ? `.${ext}` : '';
  const s3RelativeKey = `${relative}${suffix}`;
  const s3Key = `builder/${s3RelativeKey}`;

  return { s3Key, s3RelativeKey, contentType, ext };
}

type AssetRow = {
  id: string;
  name: string | null;
  url: string;
  type: string | null;
};

/** Admin SDK returns `{ data: { assets: [...] } }` (GraphQL-style payload). */
function assetsFromQueryResponse(response: unknown): AssetRow[] {
  const r = response as {
    data?: { assets?: AssetRow[] };
    assets?: AssetRow[];
  };
  return r.data?.assets ?? r.assets ?? [];
}

async function fetchAllAssets(): Promise<AssetRow[]> {
  const limit = 100;
  let offset = 0;
  const out: AssetRow[] = [];

  for (;;) {
    const input = {
      limit,
      offset,
    };

    const response = await adminSDK.query({
      assets: [
        { input },
        {
          id: true,
          name: true,
          url: true,
          type: true,
        },
      ],
    });

    const batch = assetsFromQueryResponse(response);
    if (batch.length === 0) break;
    out.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }

  return out;
}

type UploadAssetResult = { key: string; url: string; didUpload: boolean };

async function uploadAssetToS3(asset: AssetRow): Promise<UploadAssetResult> {
  const urlObj = new URL(asset.url);
  const fetchUrl = urlObj.href;

  let headerContentType: string | null = null;
  const tentative = computeS3KeyParts(asset, urlObj, null);
  if (!tentative.ext) {
    try {
      const headRes = await fetch(fetchUrl, { method: 'HEAD' });
      if (headRes.ok) {
        headerContentType = headRes.headers.get('content-type');
      }
    } catch {
      // ignore
    }
  }

  let parts = computeS3KeyParts(asset, urlObj, headerContentType);

  const bucket = process.env.AWS_BUCKET_NAME!;

  try {
    await s3.headObject({ Bucket: bucket, Key: parts.s3Key }).promise();
    return {
      key: parts.s3Key,
      url: `${publicDomain}/${parts.s3RelativeKey}`,
      didUpload: false,
    };
  } catch (err: unknown) {
    if (!isS3NotFound(err)) throw err;
  }

  const response = await fetch(fetchUrl);
  if (!response.ok) {
    throw new Error(
      `Error fetching file from ${asset.url}: ${response.status} ${response.statusText}`,
    );
  }

  const getHeader = response.headers.get('content-type');
  parts = computeS3KeyParts(asset, urlObj, getHeader);
  const contentType = normalizeContentType(asset.type, getHeader);

  try {
    await s3.headObject({ Bucket: bucket, Key: parts.s3Key }).promise();
    void response.body?.cancel();
    return {
      key: parts.s3Key,
      url: `${publicDomain}/${parts.s3RelativeKey}`,
      didUpload: false,
    };
  } catch (err: unknown) {
    if (!isS3NotFound(err)) throw err;
  }

  const arrayBuffer = await response.arrayBuffer();
  const fileBuffer = Buffer.from(arrayBuffer);

  try {
    await s3.headObject({ Bucket: bucket, Key: parts.s3Key }).promise();
    return {
      key: parts.s3Key,
      url: `${publicDomain}/${parts.s3RelativeKey}`,
      didUpload: false,
    };
  } catch (err: unknown) {
    if (!isS3NotFound(err)) throw err;
  }

  console.log('uploading file:', `${publicDomain}/${parts.s3RelativeKey}`);

  await s3
    .upload({
      Bucket: bucket,
      Key: parts.s3Key,
      Body: fileBuffer,
      ContentType: contentType,
    })
    .promise();

  return {
    key: parts.s3Key,
    url: `${publicDomain}/${parts.s3RelativeKey}`,
    didUpload: true,
  };
}

export type PushAssetsResult = {
  uploaded: { id: string; key: string; url: string }[];
  skipped: { id: string; reason: string }[];
  failed: { id: string; error: string }[];
};

export const pushAssets = async (): Promise<PushAssetsResult> => {
  const assets = await fetchAllAssets();
  const uploaded: PushAssetsResult['uploaded'] = [];
  const skipped: PushAssetsResult['skipped'] = [];
  const failed: PushAssetsResult['failed'] = [];

  for (const asset of assets) {
    if (!asset.url) {
      skipped.push({ id: asset.id, reason: 'missing url' });
      continue;
    }

    try {
      const { key, url, didUpload } = await uploadAssetToS3(asset);
      if (didUpload) {
        uploaded.push({ id: asset.id, key, url });
      } else {
        skipped.push({ id: asset.id, reason: 'already on s3' });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      failed.push({ id: asset.id, error: message });
    }
  }

  return { uploaded, skipped, failed };
};

// const main = async () => {
//   await pushAssets();
//   // console.log(JSON.stringify(result, null, 2));
// };

// if (require.main === module) {
//   main().catch(console.error);
// }
