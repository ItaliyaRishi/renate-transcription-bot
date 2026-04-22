import { Buffer } from "node:buffer";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CreateBucketCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

export function createS3Client(opts: {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}): S3Client {
  return new S3Client({
    endpoint: opts.endpoint,
    region: opts.region,
    credentials: {
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
    },
    forcePathStyle: opts.forcePathStyle,
  });
}

export async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (err) {
    const code = (err as { name?: string; Code?: string }).name
      ?? (err as { Code?: string }).Code;
    if (code === "BucketAlreadyOwnedByYou" || code === "BucketAlreadyExists") return;
    // MinIO may reply with a non-standard error on race; ignore.
  }
}

export async function putAudioChunk(
  client: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
  contentType = "audio/wav"
): Promise<void> {
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType })
  );
}

export async function getAudioChunk(
  client: S3Client,
  bucket: string,
  key: string
): Promise<Buffer> {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`s3 get: empty body for ${key}`);
  const chunks: Uint8Array[] = [];
  // @ts-expect-error — Body is a Node Readable when running in node
  for await (const c of res.Body) chunks.push(c);
  return Buffer.concat(chunks);
}

export async function objectExists(
  client: S3Client,
  bucket: string,
  key: string
): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}
