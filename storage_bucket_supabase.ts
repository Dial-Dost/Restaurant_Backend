import { createClient } from "@supabase/supabase-js";

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