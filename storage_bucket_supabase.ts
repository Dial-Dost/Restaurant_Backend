import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { POSTER_MAX_DIMENSION, type PosterContentType } from "./posters.js";

let hasWarnedMissingConfig = false;

const getSupabaseStorageClient = () => {
    const url = process.env.SUPABASE_PROJECT_URL;
    const key = process.env.SUPABASE_DEFAULT_API_KEY;

    if (!url || !key) {
        if (!hasWarnedMissingConfig) {
            hasWarnedMissingConfig = true;
            console.warn(
                "Supabase storage is disabled: missing SUPABASE_PROJECT_URL or SUPABASE_DEFAULT_API_KEY."
            );
        }
        return null;
    }

    return createClient(url, key);
};

// const { data, error } = await supabase.storage
//     .from("logos")
//     // .createSignedUrl("res_logo_placeholder.jpg", 60);;
//     .list();

// if (error) {
//     console.error("Storage access failed:", error.message);
// } else {
//     console.log("Files in bucket:", data);
// }


export async function downloadFile(url: string): Promise<Blob | null> {
    const supabase = getSupabaseStorageClient();
    if (!supabase) {
        return null;
    }

    const bucket = url.split('/')[0];
    const path = url.split('/').slice(1).join('/');

    if(!bucket || !path) {
        console.error('Invalid URL format. Expected format: bucket/path/to/file');
        return null;
    }

    const { data, error } = await supabase.storage.from(bucket).download(path);
    if (error) {
        console.error('Error downloading file:', error);
        return null;
    }

    return data;
}

// Upload a base64 image to a public bucket and return its public URL.
export async function uploadImage(
    base64: string,
    contentType: string,
    bucket: string,
    prefix: string,
): Promise<string | null> {
    const supabase = getSupabaseStorageClient();
    if (!supabase) {
        return null;
    }
    const cleaned = base64.includes(',') ? (base64.split(',').pop() ?? base64) : base64;
    let buffer: Buffer;
    try {
        buffer = Buffer.from(cleaned, 'base64');
    } catch {
        return null;
    }
    const lowered = contentType.toLowerCase();
    const ext = lowered.includes('png') ? 'png' : lowered.includes('webp') ? 'webp' : 'jpg';
    const path = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await supabase.storage.from(bucket).upload(path, buffer, { contentType, upsert: false });
    if (error) {
        console.error('upload_image_failed', { bucket, error });
        return null;
    }
    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    return data?.publicUrl ?? null;
}

// Customer payment screenshot → public "payment-proofs" bucket (staff review).
export async function uploadScreenshot(base64: string, contentType: string): Promise<string | null> {
    return uploadImage(base64, contentType, 'payment-proofs', 'proof');
}

// Menu item photo → public "menu-images" bucket (shown to customers).
export async function uploadMenuImage(base64: string, contentType: string): Promise<string | null> {
    return uploadImage(base64, contentType, 'menu-images', 'menu');
}

// Upload a Buffer (rather than base64) to a public bucket. Same object naming as
// uploadImage; split out because the poster path re-encodes the bytes before
// storing them and has no reason to round-trip them back through base64.
async function uploadBuffer(
    buffer: Buffer,
    contentType: string,
    bucket: string,
    prefix: string,
    ext: string,
): Promise<string | null> {
    const supabase = getSupabaseStorageClient();
    if (!supabase) {
        return null;
    }
    const path = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await supabase.storage.from(bucket).upload(path, buffer, { contentType, upsert: false });
    if (error) {
        console.error('upload_buffer_failed', { bucket, error });
        return null;
    }
    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    return data?.publicUrl ?? null;
}

/**
 * Why this is a discriminated result and not `string | null`: the two ways a
 * poster upload fails need two different answers. "These bytes are not an image"
 * is the OWNER'S problem and must come back as a 400 they can act on; "the
 * storage bucket is not configured" is OURS and must come back as a 502, the
 * same way /menu/upload-image already answers it. Collapsing both into null
 * would tell an owner with a perfectly good JPEG to go and re-export it while
 * the real fault sat in the environment.
 */
export type PosterUploadResult =
    | { ok: true; url: string; width: number; height: number; bytes: number }
    | { ok: false; reason: "unreadable" | "storage" };

/**
 * Promotional poster → the SAME public "menu-images" bucket every other
 * owner-uploaded customer-facing image already lands in (dish photos via
 * uploadMenuImage, and the restaurant logo, which routes/settings.ts also puts
 * there). A "posters" bucket would have read better and would have 404'd in
 * production: buckets are provisioned in the Supabase project, not by this code,
 * so a bucket name no one has created makes every upload fail with a storage
 * error the owner cannot act on. The object prefix (`poster_…`) is what
 * distinguishes them, exactly as `menu_…` and `proof_…` already do.
 *
 * THE BYTES ARE RE-ENCODED, NOT JUST CHECKED. validatePosterUpload has already
 * bounded the payload and vetted the DECLARED type; that declaration is a claim
 * by the client. Decoding through sharp does three things a header check cannot:
 *   1. it proves the payload really is an image (a .png that is actually a zip
 *      throws here instead of being served to diners as a broken tile);
 *   2. it caps the DIMENSIONS, which is what actually decides how long a guest
 *      on a phone waits — a 6000px camera export becomes 1600px;
 *   3. it strips EXIF, which routinely carries the GPS coordinates of wherever
 *      the owner photographed their poster.
 * WebP because it is the smallest of the three formats we accept and every
 * browser that can run these guest pages has supported it for years.
 */
export async function uploadPosterImage(
    base64: string,
    contentType: PosterContentType,
): Promise<PosterUploadResult> {
    const cleaned = base64.includes(',') ? (base64.split(',').pop() ?? base64) : base64;
    let source: Buffer;
    try {
        source = Buffer.from(cleaned, 'base64');
    } catch {
        return { ok: false, reason: 'unreadable' };
    }
    if (source.length === 0) {
        return { ok: false, reason: 'unreadable' };
    }
    // Declared without initialisers: the catch below RETURNS, so there is no
    // path where a placeholder value could ever be read.
    let encoded: Buffer;
    let width: number;
    let height: number;
    try {
        const out = await sharp(source)
            // withoutEnlargement: a small poster stays small. Upscaling a 400px
            // image to 1600 would multiply the bytes a guest downloads by 16 to
            // show them the same blur.
            .resize(POSTER_MAX_DIMENSION, POSTER_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
            .rotate() // honour the EXIF orientation before it is stripped
            .webp({ quality: 82 })
            .toBuffer({ resolveWithObject: true });
        encoded = out.data;
        width = out.info.width;
        height = out.info.height;
    } catch (err) {
        // Not an image, or an image sharp refuses (a decompression bomb hits this
        // path too — sharp has its own pixel limit). The declared content type
        // said otherwise, which is precisely why this runs.
        console.warn('poster_image_decode_failed', { contentType, err });
        return { ok: false, reason: 'unreadable' };
    }
    const url = await uploadBuffer(encoded, 'image/webp', 'menu-images', 'poster', 'webp');
    return url
        ? { ok: true, url, width, height, bytes: encoded.length }
        : { ok: false, reason: 'storage' };
}